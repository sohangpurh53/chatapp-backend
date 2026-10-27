// HTTP side of calls: GET /api/calls/:id/status (what a push-woken app asks before it
// keeps ringing) and POST /api/calls/clear-status (run by the app on every start)
const { describe, test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

console.log = () => {};

// Sign-in has its own tests: the caller is whoever the x-user header says
require.cache[require.resolve('../middleware/auth')] = {
  id: 'auth', loaded: true,
  exports: {
    authenticateToken: (req, res, next) => { req.user = { id: req.headers['x-user'] }; next(); },
    authenticateSocket: (socket, next) => next(),
  },
};

const { installCallStore, redisService } = require('./helpers/callHarness');
const callRoutes = require('../routes/calls');

redisService.client.disconnect();
after(() => redisService.client.disconnect());

describe('call routes', () => {
  let env;
  let store;
  let server;
  let base;

  beforeEach(async () => {
    env = installCallStore();
    store = env.store;
    const app = express();
    app.use(express.json());
    app.use('/api/calls', callRoutes);
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}/api/calls`;
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    env.restore();
  });

  const request = async (method, path, user) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'x-user': user } });
    return { status: response.status, body: await response.json() };
  };
  const liveCall = (overrides = {}) => {
    const call = { id: 'c1', callerId: 'alice', receiverId: 'bob', status: 'ringing', startedAt: new Date() };
    store.calls.set('c1', { ...call, ...overrides });
  };

  describe('GET /:callId/status', () => {
    test('a ringing call is reported to both people on it', async () => {
      liveCall();
      assert.deepEqual((await request('GET', '/c1/status', 'bob')).body, { callId: 'c1', status: 'ringing' });
      assert.deepEqual((await request('GET', '/c1/status', 'alice')).body, { callId: 'c1', status: 'ringing' });
    });

    test('an answered call says so (so a second device stops ringing)', async () => {
      liveCall({ status: 'answered' });
      assert.equal((await request('GET', '/c1/status', 'bob')).body.status, 'answered');
    });

    test('someone who is not on the call gets "not found", not its details', async () => {
      liveCall();
      const result = await request('GET', '/c1/status', 'mallory');
      assert.equal(result.status, 404);
      assert.equal(result.body.error, 'Call not found');
    });

    test('a call that is over is "ended" even though the database row still says it was in progress', async () => {
      store.dbCalls.set('c2', { id: 'c2', callerId: 'alice', receiverId: 'bob', status: 'answered' });
      store.dbCalls.set('c3', { id: 'c3', callerId: 'alice', receiverId: 'bob', status: 'initiated' });

      assert.equal((await request('GET', '/c2/status', 'bob')).body.status, 'ended');
      assert.equal((await request('GET', '/c3/status', 'bob')).body.status, 'ended');
    });

    test('finished calls report how they finished', async () => {
      store.dbCalls.set('c4', { id: 'c4', callerId: 'alice', receiverId: 'bob', status: 'missed' });
      store.dbCalls.set('c5', { id: 'c5', callerId: 'alice', receiverId: 'bob', status: 'declined' });

      assert.equal((await request('GET', '/c4/status', 'bob')).body.status, 'missed');
      assert.equal((await request('GET', '/c5/status', 'alice')).body.status, 'declined');
    });

    test('an unknown call, or someone else\'s finished call, is "not found" (the app keeps ringing on any other error)', async () => {
      store.dbCalls.set('c6', { id: 'c6', callerId: 'alice', receiverId: 'bob', status: 'ended' });

      assert.equal((await request('GET', '/nope/status', 'bob')).status, 404);
      assert.equal((await request('GET', '/c6/status', 'mallory')).status, 404);
      assert.equal((await request('GET', '/nope/status', 'bob')).body.error, 'Call not found');
    });
  });

  describe('POST /clear-status', () => {
    test('does nothing when there is nothing to clear', async () => {
      const result = await request('POST', '/clear-status', 'bob');
      assert.equal(result.body.success, true);
      assert.equal(result.body.clearedCallId, undefined);
    });

    test('keeps a call that is ringing for this user: the app may have been started by that push', async () => {
      liveCall();
      store.userCalls.set('bob', { callId: 'c1', status: 'receiving' });
      store.userCalls.set('alice', { callId: 'c1', status: 'calling' });

      const result = await request('POST', '/clear-status', 'bob');

      assert.equal(result.body.clearedCallId, undefined);
      assert.ok(store.calls.has('c1'));
      assert.ok(store.userCalls.has('bob'));
      assert.ok(store.userCalls.has('alice'));
    });

    test('clears a call left over from the previous session, for both people', async () => {
      liveCall({ status: 'answered' });
      store.userCalls.set('bob', { callId: 'c1', status: 'receiving' });
      store.userCalls.set('alice', { callId: 'c1', status: 'calling' });

      const result = await request('POST', '/clear-status', 'bob');

      assert.equal(result.body.clearedCallId, 'c1');
      assert.equal(store.calls.size, 0);
      assert.equal(store.userCalls.size, 0);
    });

    test('a caller\'s own ringing call is not kept (their app just started, so that call is dead)', async () => {
      liveCall();
      store.userCalls.set('alice', { callId: 'c1', status: 'calling' });
      store.userCalls.set('bob', { callId: 'c1', status: 'receiving' });

      const result = await request('POST', '/clear-status', 'alice');

      assert.equal(result.body.clearedCallId, 'c1');
      assert.equal(store.calls.size, 0);
    });

    test('clears status that points at a call that no longer exists', async () => {
      store.userCalls.set('bob', { callId: 'gone', status: 'receiving' });

      const result = await request('POST', '/clear-status', 'bob');

      assert.equal(result.body.clearedCallId, 'gone');
      assert.equal(store.userCalls.size, 0);
    });
  });
});
