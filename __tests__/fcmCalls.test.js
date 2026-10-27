// What the FCM service actually puts on the wire for calls. A mistake here is invisible
// to every other test: the push still "sends", but Android shows a system notification
// instead of waking the app, or keeps ringing a call for four weeks.
const { describe, test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');

console.log = () => {};
console.error = () => {};

const sent = [];
let sendError = () => null;
let sendDelayMs = 0;
let inFlight = 0;
let peakInFlight = 0;
require.cache[require.resolve('../config/firebase')] = {
  id: 'firebase', loaded: true,
  exports: {
    getMessaging: () => ({
      send: async (message) => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        if (sendDelayMs) await new Promise(resolve => setTimeout(resolve, sendDelayMs));
        inFlight -= 1;
        const error = sendError(message);
        if (error) throw error;
        sent.push(message);
        return `message-${sent.length}`;
      },
    }),
  },
};

const fcmService = require('../services/fcmService');
const deviceService = require('../services/deviceService');
const redisService = require('../config/redis');

redisService.client.disconnect();
after(() => redisService.client.disconnect());

const stubs = [];
const stub = (object, name, replacement) => {
  stubs.push([object, name, object[name]]);
  object[name] = replacement;
};

const phone = (deviceId, extra = {}) => ({ fcmToken: `token-${deviceId}`, deviceId, deviceName: deviceId, notificationPreferences: {}, ...extra });

describe('FCM payloads for calls', () => {
  let devices;
  let deactivated;

  beforeEach(() => {
    sent.length = 0;
    sendError = () => null;
    sendDelayMs = 0;
    inFlight = 0;
    peakInFlight = 0;
    devices = [phone('pixel')];
    deactivated = [];
    stub(deviceService, 'getActiveFCMTokens', async () => devices);
    stub(deviceService, 'deactivateDevice', async (userId, deviceId) => { deactivated.push([userId, deviceId]); });
  });

  afterEach(() => {
    while (stubs.length) {
      const [object, name, original] = stubs.pop();
      object[name] = original;
    }
  });

  const incomingCall = (extra = {}) => ({
    type: 'incoming_call_offline',
    ttlMs: 45000,
    data: {
      type: 'incoming_call_offline',
      callId: 'c1',
      callerName: 'alice',
      callType: 'video',
      notificationTitle: 'Incoming video call',
      notificationBody: 'alice is calling you',
      ringExpiresAt: '1900000000000',
      ...extra,
    },
  });

  describe('an incoming call', () => {
    test('is data-only, high priority, and replaces any earlier ring', async () => {
      await fcmService.sendNotification('bob', incomingCall());

      const [message] = sent;
      assert.equal(message.token, 'token-pixel');
      assert.equal(message.notification, undefined, 'a system notification would not wake the app\'s own ringing screen');
      assert.equal(message.android.notification, undefined);
      assert.equal(message.android.priority, 'high');
      assert.equal(message.android.collapseKey, 'incoming_call');
    });

    test('expires when the ringing does, so a late push never rings a dead call', async () => {
      await fcmService.sendNotification('bob', incomingCall());

      assert.equal(sent[0].android.ttl, 45000);
    });

    test('carries what the app needs to show and judge the ring', async () => {
      await fcmService.sendNotification('bob', incomingCall());

      const { data } = sent[0];
      assert.equal(data.type, 'incoming_call_offline');
      assert.equal(data.callId, 'c1');
      assert.equal(data.ringExpiresAt, '1900000000000');
      assert.equal(data.notificationTitle, 'Incoming video call');
      assert.equal(data.notificationBody, 'alice is calling you');
    });

    test('has only string values (FCM rejects anything else) and no call signal in it', async () => {
      await fcmService.sendNotification('bob', incomingCall({ chatId: 12345 }));

      for (const [key, value] of Object.entries(sent[0].data)) {
        assert.equal(typeof value, 'string', `${key} must be a string`);
      }
      assert.equal(sent[0].data.signalData, undefined);
    });

    test('is not sent to a phone whose user turned call notifications off', async () => {
      devices = [phone('pixel', { notificationPreferences: { calls: false } })];

      const result = await fcmService.sendNotification('bob', incomingCall());

      assert.equal(sent.length, 0);
      assert.equal(result.success, false);
    });
  });

  describe('call ended', () => {
    const callEnded = (reason = 'missed') => ({
      type: 'call_ended',
      ttlMs: 45000,
      data: { type: 'call_ended', callId: 'c1', endedBy: 'alice', reason, action: 'call_ended' },
    });

    test('is data-only and high priority, so the app can stop the ringing notification', async () => {
      await fcmService.sendNotification('bob', callEnded());

      const [message] = sent;
      assert.equal(message.notification, undefined, 'Android does not run app code for a notification message while the app is closed');
      assert.equal(message.android.notification, undefined);
      assert.equal(message.android.priority, 'high');
      assert.equal(message.data.type, 'call_ended');
      assert.equal(message.data.callId, 'c1');
      assert.equal(message.data.reason, 'missed');
    });

    test('is not kept for weeks', async () => {
      await fcmService.sendNotification('bob', callEnded());
      assert.equal(sent[0].android.ttl, 45000);
    });

    test('does not collapse into the ring it cancels', async () => {
      await fcmService.sendNotification('bob', callEnded());
      assert.equal(sent[0].android.collapseKey, undefined);
    });
  });

  describe('everything else keeps working as before', () => {
    test('a plain message still shows a system notification on its channel', async () => {
      await fcmService.sendNotification('bob', {
        type: 'new_message', title: 'alice', body: 'hi',
        data: { type: 'new_message', chatId: 'chat-1' },
      });

      const [message] = sent;
      assert.deepEqual(message.notification, { title: 'alice', body: 'hi' });
      assert.equal(message.android.notification.channelId, 'chat_messages');
      assert.equal(message.android.priority, 'normal');
      assert.equal(message.android.ttl, undefined);
    });

    test('an encrypted message is data-only and high priority, with no TTL forced on it', async () => {
      await fcmService.sendNotification('bob', {
        type: 'new_message', title: 'alice', body: 'Encrypted message',
        data: { type: 'new_message', isEncrypted: 'true' },
      });

      assert.equal(sent[0].notification, undefined);
      assert.equal(sent[0].android.priority, 'high');
      assert.equal(sent[0].android.ttl, undefined);
    });
  });

  describe('several devices', () => {
    test('all of them are rung', async () => {
      devices = [phone('pixel'), phone('tablet'), phone('poco')];

      const result = await fcmService.sendNotification('bob', incomingCall());

      assert.deepEqual(sent.map(m => m.token).sort(), ['token-pixel', 'token-poco', 'token-tablet']);
      assert.equal(result.success, true);
    });

    test('they are sent at the same time, not one after the other', async () => {
      devices = [phone('a'), phone('b'), phone('c')];
      sendDelayMs = 30;

      const startedAt = Date.now();
      await fcmService.sendNotification('bob', incomingCall());

      assert.equal(peakInFlight, 3);
      assert.ok(Date.now() - startedAt < 80, 'three 30 ms sends took about 30 ms, not 90');
    });

    test('one device failing does not stop the others, and the call still counts as sent', async () => {
      devices = [phone('broken'), phone('works')];
      sendError = (message) => (message.token === 'token-broken' ? new Error('boom') : null);

      const result = await fcmService.sendNotification('bob', incomingCall());

      assert.equal(result.success, true);
      assert.deepEqual(sent.map(m => m.token), ['token-works']);
      assert.equal(result.deviceResults.filter(r => r.success).length, 1);
    });

    test('a token Google no longer knows is retired so it is not tried on every call', async () => {
      devices = [phone('old'), phone('new')];
      sendError = (message) => (message.token === 'token-old'
        ? Object.assign(new Error('gone'), { code: 'messaging/registration-token-not-registered' })
        : null);

      await fcmService.sendNotification('bob', incomingCall());

      assert.deepEqual(deactivated, [['bob', 'old']]);
      assert.deepEqual(sent.map(m => m.token), ['token-new']);
    });

    test('a user with no registered device is reported, not an error', async () => {
      devices = [];

      const result = await fcmService.sendNotification('bob', incomingCall());

      assert.deepEqual(result, { success: false, reason: 'no_active_tokens' });
    });
  });
});
