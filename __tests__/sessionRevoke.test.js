const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { UserSession, UserDevice } = require('../models');
const fcmService = require('../services/fcmService');
const sessionService = require('../services/sessionService');

describe('session revoke notifications', () => {
  let emitted;
  let original;

  beforeEach(() => {
    emitted = [];
    const room = () => ({
      emit: (event, data) => emitted.push({ event, data }),
      disconnectSockets: () => {},
    });
    sessionService.setIO({ to: room, in: room });
    original = UserSession.findOne;
  });

  afterEach(() => {
    UserSession.findOne = original;
    // The server cuts the socket 500 ms later; keep a harmless stub for that
    const quiet = () => ({ emit: () => {}, disconnectSockets: () => {} });
    sessionService.setIO({ to: quiet, in: quiet });
  });

  const sessionRow = () => ({
    id: 's1',
    userId: 'u1',
    revokedAt: null,
    update: async function (fields) { Object.assign(this, fields); },
  });

  test('a device logging itself out is not told it was revoked (that would wipe its keys)', async () => {
    UserSession.findOne = async () => sessionRow();

    await sessionService.revokeById('u1', 's1', 'logout');

    assert.deepEqual(emitted, []);
  });

  test('a device signed out from another device is told, so it can wipe its keys', async () => {
    UserSession.findOne = async () => sessionRow();

    await sessionService.revokeById('u1', 's1', 'remote');

    assert.deepEqual(emitted, [{ event: 'session_revoked', data: { sessionId: 's1', reason: 'remote' } }]);
  });

  describe('a device whose socket is asleep', () => {
    const originals = { findOne: UserDevice.findOne, update: UserDevice.update, check: fcmService.sendSessionCheck };
    let order;

    beforeEach(() => {
      order = [];
      UserSession.findOne = async () => ({ ...sessionRow(), deviceId: 'd1', update: async () => {} });
      UserDevice.findOne = async () => ({ fcmToken: 'token-1' });
      UserDevice.update = async () => { order.push('token removed'); return [1]; };
      fcmService.sendSessionCheck = async (token) => { order.push(`push ${token}`); };
    });

    afterEach(() => {
      UserDevice.findOne = originals.findOne;
      UserDevice.update = originals.update;
      fcmService.sendSessionCheck = originals.check;
    });

    test('is pushed before its token is removed', async () => {
      await sessionService.revokeById('u1', 's1', 'remote');

      assert.deepEqual(order, ['push token-1', 'token removed']);
    });

    test('logging out of this device pushes nothing', async () => {
      await sessionService.revokeById('u1', 's1', 'logout');

      assert.deepEqual(order, ['token removed']);
    });

    test('a failed push still signs the device out', async () => {
      fcmService.sendSessionCheck = async () => { throw new Error('FCM down'); };

      assert.equal(await sessionService.revokeById('u1', 's1', 'remote'), true);
      assert.deepEqual(order, ['token removed']);
    });
  });
});
