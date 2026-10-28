const { test, describe, beforeEach, afterEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');

// The call handlers log every step; under `node --test` that output in the child's
// stdout trips the runner ("Unable to deserialize cloned data")
console.log = () => {};

// The real notification and push services open job queues and Firebase; the tests
// record what would have been pushed instead
const notificationService = { notifyMissedCall: async () => {}, notifyNewMessage: async () => {} };
require.cache[require.resolve('../services/notificationService')] = {
  id: 'notificationService', loaded: true, exports: notificationService,
};
const pushes = [];
const fcmService = { sendNotification: async (userId, notification) => { pushes.push({ userId, notification }); return { success: true }; } };
require.cache[require.resolve('../services/fcmService')] = {
  id: 'fcmService', loaded: true, exports: fcmService,
};

const { Call, User, UserBlock } = require('../models');
const redisService = require('../config/redis');
const SocketHandlers = require('../socket/socketHandlers');

redisService.client.disconnect();
after(() => redisService.client.disconnect());

const stubs = [];
const stub = (object, name, replacement) => {
  stubs.push([object, name, object[name]]);
  object[name] = replacement;
};
afterEach(() => {
  while (stubs.length) {
    const [object, name, original] = stubs.pop();
    object[name] = original;
  }
});

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('calls', () => {
  let handlers;
  let roomEmits;   // { room, event, data, except? }
  let rooms;       // room -> Set of socket ids
  let ackers;      // socket ids that acknowledge 'incoming_call'
  let calls;       // Redis call:<id>
  let userCalls;   // Redis user_call:<id>
  let pending;     // Redis pending_signals:<user>:<call>

  const socketFor = (userId, id = `${userId}-socket`) => {
    const emitted = [];
    return {
      id,
      userId,
      user: { username: userId },
      emitted,
      emit: (event, data) => emitted.push({ event, data }),
      to: (room) => ({ emit: (event, data) => roomEmits.push({ room, event, data, except: id }) }),
    };
  };
  const connect = (userId) => {
    const room = `user_${userId}`;
    if (!rooms.has(room)) rooms.set(room, new Set());
    rooms.get(room).add(`${userId}-socket`);
  };
  const emitsTo = (room, event) => roomEmits.filter(e => e.room === room && e.event === event);

  beforeEach(() => {
    roomEmits = [];
    rooms = new Map();
    ackers = new Set();
    calls = new Map();
    userCalls = new Map();
    pending = new Map();
    pushes.length = 0;

    const broadcast = (room, ackTimeout) => ({
      timeout: (ms) => broadcast(room, ms),
      emit: (event, data, ack) => {
        roomEmits.push({ room, event, data });
        if (ack) {
          const responses = [...(rooms.get(room) || [])].filter(id => ackers.has(id)).map(() => ({ ok: true }));
          setImmediate(() => ack(null, responses));
        }
      },
    });
    const io = {
      to: (room) => broadcast(room),
      emit: () => {},
      sockets: { adapter: { rooms } },
      of: () => ({ sockets: new Map() }),
    };
    handlers = new SocketHandlers(io);

    stub(redisService, 'getActiveCall', async (id) => calls.get(id) ? { ...calls.get(id) } : null);
    stub(redisService, 'setActiveCall', async (id, data) => { calls.set(id, { ...data }); });
    stub(redisService, 'deleteActiveCall', async (id) => { calls.delete(id); });
    stub(redisService, 'getUserCallStatus', async (userId) => userCalls.get(userId) || null);
    stub(redisService, 'setUserCallStatus', async (userId, callId, status) => { userCalls.set(userId, { callId, status }); });
    stub(redisService, 'deleteUserCallStatus', async (userId) => { userCalls.delete(userId); });
    stub(redisService, 'getPendingSignals', async (userId, callId) => pending.get(`${userId}:${callId}`) || []);
    stub(redisService, 'deletePendingSignals', async (userId, callId) => { pending.delete(`${userId}:${callId}`); });
    stub(redisService, 'pushPendingSignal', async (userId, callId, signal) => {
      const key = `${userId}:${callId}`;
      pending.set(key, [...(pending.get(key) || []), signal]);
    });
    stub(User, 'findByPk', async (id) => ({ id, username: id, avatar: null }));
    stub(UserBlock, 'findAll', async () => []); // nobody is blocked here
    stub(Call, 'create', async () => ({}));
    stub(Call, 'update', async () => [1]);
  });

  afterEach(() => {
    for (const timer of handlers.callTimeouts.values()) clearTimeout(timer);
    for (const timer of handlers.callDisconnectTimers.values()) clearTimeout(timer);
  });

  const startCall = async () => {
    const caller = socketFor('alice');
    await handlers.handleInitiateCall(caller, { receiverId: 'bob', callType: 'voice' });
    await flush();
    const { callId } = caller.emitted.find(e => e.event === 'call_initiated').data;
    return { caller, callId };
  };

  test('a connected app that acknowledges the ring gets no push', async () => {
    connect('alice');
    connect('bob');
    ackers.add('bob-socket');

    const { callId } = await startCall();

    assert.equal(emitsTo('user_bob', 'incoming_call').length, 1);
    assert.equal(pushes.length, 0);
    assert.deepEqual(emitsTo('user_alice', 'call_status_update')[0].data, { callId, status: 'ringing' });
  });

  test('a socket that never acknowledges (half-open after Doze) still gets the push', async () => {
    connect('alice');
    connect('bob');

    const { callId } = await startCall();

    assert.equal(emitsTo('user_bob', 'incoming_call').length, 1);
    assert.equal(pushes.length, 1);
    const push = pushes[0].notification;
    assert.equal(push.data.type, 'incoming_call_offline');
    assert.equal(push.data.callId, callId);
    assert.ok(push.ttlMs > 0 && push.ttlMs <= 45000);
    assert.ok(Number(push.data.ringExpiresAt) > Date.now());
  });

  test('a receiver with no socket is pushed, and the caller hears back first', async () => {
    connect('alice');

    const { caller } = await startCall();

    assert.equal(caller.emitted[0].event, 'call_initiated');
    assert.equal(caller.emitted[0].data.receiverOnline, false);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].userId, 'bob');
  });

  test('busy check reads the call id out of the stored status', async () => {
    connect('bob');
    calls.set('other-call', { id: 'other-call', callerId: 'carol', receiverId: 'bob', status: 'answered' });
    userCalls.set('bob', { callId: 'other-call', status: 'receiving' });
    const caller = socketFor('alice');

    await handlers.handleInitiateCall(caller, { receiverId: 'bob', callType: 'voice' });

    assert.deepEqual(caller.emitted.map(e => e.data.message), ['User is busy']);
  });

  test('a ring left over from before a restart does not make the receiver busy', async () => {
    calls.set('old', { id: 'old', callerId: 'carol', receiverId: 'bob', status: 'ringing', startedAt: new Date(Date.now() - 120000) });
    userCalls.set('bob', { callId: 'old', status: 'receiving' });

    const { callId } = await startCall();

    assert.ok(callId);
    assert.equal(calls.has('old'), false);
  });

  test('answering hands a push-woken phone the offer it missed', async () => {
    connect('alice');
    const { callId } = await startCall();
    await handlers.handleCallSignal(socketFor('alice'), { callId, targetUserId: 'bob', signal: { type: 'offer', sdp: 'v=0' } });
    connect('bob');
    const receiver = socketFor('bob');

    await handlers.handleAnswerCall(receiver, { callId, hasOffer: false });

    const signal = receiver.emitted.find(e => e.event === 'call_signal').data;
    assert.equal(signal.signal.type, 'offer');
    assert.equal(signal.fromUserId, 'alice');
    assert.equal(emitsTo('user_alice', 'call_answered').length, 1);
    assert.equal(emitsTo('user_alice', 'call_signal').length, 0);
    assert.equal(pending.size, 0);
  });

  test('an offer relayed into a half-open socket is still there when the phone answers from the push', async () => {
    connect('alice');
    connect('bob'); // looks connected, but never acknowledges anything
    const { callId } = await startCall();
    await handlers.handleCallSignal(socketFor('alice'), { callId, targetUserId: 'bob', signal: { type: 'offer', sdp: 'v=0' } });
    await handlers.handleCallSignal(socketFor('alice'), { callId, targetUserId: 'bob', signal: { type: 'ice-candidate' } });
    assert.equal(emitsTo('user_bob', 'call_signal').length, 2);

    const fromPush = socketFor('bob', 'bob-new-socket');
    await handlers.handleAnswerCall(fromPush, { callId, hasOffer: false });

    assert.deepEqual(fromPush.emitted.filter(e => e.event === 'call_signal').map(e => e.data.signal.type), ['offer', 'ice-candidate']);
    assert.equal(emitsTo('user_alice', 'call_signal').length, 0);
  });

  test('a receiver that got the offer live drops the stored copy on answer', async () => {
    connect('alice');
    connect('bob');
    ackers.add('bob-socket');
    const { callId } = await startCall();
    await handlers.handleCallSignal(socketFor('alice'), { callId, targetUserId: 'bob', signal: { type: 'offer', sdp: 'v=0' } });

    await handlers.handleAnswerCall(socketFor('bob'), { callId, hasOffer: true });

    assert.equal(pending.size, 0);
  });

  test('signals during the call itself are only relayed', async () => {
    connect('alice');
    connect('bob');
    ackers.add('bob-socket');
    const { callId } = await startCall();
    await handlers.handleAnswerCall(socketFor('bob'), { callId, hasOffer: true });

    await handlers.handleCallSignal(socketFor('alice'), { callId, targetUserId: 'bob', signal: { type: 'ice-candidate' } });

    assert.equal(pending.size, 0);
  });

  test('answering without a stored offer asks the caller for a fresh one', async () => {
    connect('alice');
    const { callId } = await startCall();
    connect('bob');

    await handlers.handleAnswerCall(socketFor('bob'), { callId, hasOffer: false });

    assert.equal(emitsTo('user_alice', 'call_signal')[0].data.signal.type, 'request-offer');
  });

  test('answering stops the ring timeout and the other devices ringing', async () => {
    connect('alice');
    connect('bob');
    ackers.add('bob-socket');
    const { callId } = await startCall();
    const receiver = socketFor('bob');

    await handlers.handleAnswerCall(receiver, { callId, hasOffer: true });
    await handlers.handleAnswerCall(receiver, { callId, hasOffer: true });

    assert.equal(handlers.callTimeouts.has(callId), false);
    assert.equal(calls.get(callId).status, 'answered');
    assert.equal(emitsTo('user_alice', 'call_answered').length, 1);
    const elsewhere = emitsTo('user_bob', 'call_ended');
    assert.equal(elsewhere.length, 1);
    assert.equal(elsewhere[0].data.reason, 'answered_elsewhere');
    assert.equal(elsewhere[0].except, 'bob-socket');
    assert.equal(receiver.emitted.filter(e => e.event === 'call_connected').length, 2);
  });

  test('a dropped socket mid-call ends the call only if it stays gone', async () => {
    connect('alice');
    connect('bob');
    ackers.add('bob-socket');
    const { callId } = await startCall();
    await handlers.handleAnswerCall(socketFor('bob'), { callId, hasOffer: true });
    roomEmits.length = 0;

    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      rooms.get('user_bob').clear();
      await handlers.scheduleCallDisconnectCleanup('bob');
      assert.equal(emitsTo('user_alice', 'call_ended').length, 0);

      // Back within the grace period
      handlers.cancelCallDisconnectTimer('bob');
      mock.timers.tick(61000);
      await flush();
      assert.equal(emitsTo('user_alice', 'call_ended').length, 0);
      assert.ok(calls.has(callId));

      // Gone for good
      await handlers.scheduleCallDisconnectCleanup('bob');
      mock.timers.tick(61000);
      await flush();
      await flush();
    } finally {
      mock.timers.reset();
    }
    assert.equal(emitsTo('user_alice', 'call_ended')[0].data.reason, 'network_error');
    assert.equal(calls.has(callId), false);
  });

  test('signals for a socket that is down wait in Redis; a new offer replaces older ones', async () => {
    connect('alice');
    connect('bob');
    ackers.add('bob-socket');
    const { callId } = await startCall();
    await handlers.handleAnswerCall(socketFor('bob'), { callId, hasOffer: true });
    rooms.get('user_bob').clear();
    const alice = socketFor('alice');

    await handlers.handleCallSignal(alice, { callId, targetUserId: 'bob', signal: { type: 'offer', sdp: '1' } });
    await handlers.handleCallSignal(alice, { callId, targetUserId: 'bob', signal: { type: 'ice-candidate' } });
    await handlers.handleCallSignal(alice, { callId, targetUserId: 'bob', signal: { type: 'offer', sdp: '2' } });

    assert.deepEqual(pending.get(`bob:${callId}`).map(s => s.payload.sdp || s.type), ['2']);
  });

  test('signals from someone outside the call are dropped', async () => {
    connect('alice');
    connect('bob');
    const { callId } = await startCall();

    await handlers.handleCallSignal(socketFor('mallory'), { callId, targetUserId: 'bob', signal: { type: 'offer' } });

    assert.equal(emitsTo('user_bob', 'call_signal').length, 0);
  });

  test('a missed call stops the ring on a push-woken phone', async () => {
    connect('alice');
    const { callId } = await startCall();
    pushes.length = 0;

    await handlers.handleMissedCall(callId);

    assert.equal(emitsTo('user_alice', 'call_missed').length, 1);
    assert.equal(pushes[0].notification.type, 'call_ended');
    assert.equal(pushes[0].notification.data.reason, 'missed');
  });
});
