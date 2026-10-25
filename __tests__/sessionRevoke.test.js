const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { UserSession } = require('../models');
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
});
