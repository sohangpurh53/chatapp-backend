const { test, describe, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: connectClient } = require('socket.io-client');

const { installCallStore, startServer, until, redisService } = require('./helpers/callHarness');
const { UserSession, UserDevice } = require('../models');
const sessionService = require('../services/sessionService');

// The Redis client connects as soon as it's loaded; nothing here needs it
redisService.client.disconnect();
after(() => redisService.client.disconnect());

describe('signing out another device, over real sockets', () => {
  let server;
  let restoreStore;
  const clients = [];
  const originals = { findOne: UserSession.findOne, update: UserDevice.update };

  const device = (sessionId) => new Promise((resolve) => {
    const socket = connectClient(server.url, { auth: { token: 'u1', sessionId }, reconnection: false });
    const seen = { socket, events: [], disconnectReason: null };
    socket.on('session_revoked', (data) => seen.events.push(data));
    socket.on('disconnect', (reason) => { seen.disconnectReason = reason; });
    socket.on('connect', () => resolve(seen));
    clients.push(socket);
  });

  beforeEach(async () => {
    restoreStore = installCallStore();
    server = await startServer();
    // The harness signs everyone in without a session
    server.io.use((socket, next) => { socket.sessionId = socket.handshake.auth.sessionId; next(); });
    sessionService.setIO(server.io);
    UserDevice.update = async () => [1];
    UserSession.findOne = async ({ where }) => ({
      id: where.id,
      userId: 'u1',
      revokedAt: null,
      update: async () => {},
    });
  });

  afterEach(async () => {
    clients.splice(0).forEach(socket => socket.disconnect());
    await server.close();
    if (typeof restoreStore === 'function') restoreStore();
    UserSession.findOne = originals.findOne;
    UserDevice.update = originals.update;
  });

  test('only the signed-out device hears about it, and it is hung up on', async () => {
    const stays = await device('keep');
    const leaves = await device('gone');

    await sessionService.revokeById('u1', 'gone', 'remote');

    await until(() => leaves.events.length === 1, { label: 'session_revoked' });
    assert.equal(leaves.events[0].reason, 'remote');
    await until(() => leaves.disconnectReason, { label: 'the hang-up' });
    assert.equal(leaves.disconnectReason, 'io server disconnect');
    assert.deepEqual(stays.events, []);
    assert.equal(stays.socket.connected, true);
  });
});
