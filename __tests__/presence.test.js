const { test, describe, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');

// The real notification service opens job queues on Redis that never let the
// test process exit
require.cache[require.resolve('../services/notificationService')] = {
  id: 'notificationService', loaded: true, exports: {},
};

const { User } = require('../models');
const redisService = require('../config/redis');
const SocketHandlers = require('../socket/socketHandlers');

// The Redis client connects as soon as it's loaded; nothing here needs it
redisService.client.disconnect();
after(() => redisService.client.disconnect());

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

describe('online status', () => {
  let handlers;
  let broadcasts;
  let redisCalls;
  let live;
  const originals = {};

  const socketOf = (id, userId = 'u1') => ({ id, userId, connected: true, user: { username: 'u' }, to: () => ({ emit() {} }) });
  const connect = (socket) => {
    live.set(socket.id, socket);
    handlers.connectedUsers.set(socket.userId, socket.id);
    handlers.markUserOnline(socket.userId, socket.id);
  };
  const drop = (socket, reason = 'transport close') => {
    live.delete(socket.id);
    return handlers.handleDisconnect(socket, reason);
  };
  const statuses = () => broadcasts.map(b => b.isOnline);

  beforeEach(() => {
    broadcasts = [];
    redisCalls = [];
    live = new Map();
    handlers = new SocketHandlers({
      emit: (event, data) => { if (event === 'user_status_changed') broadcasts.push(data); },
      of: () => ({ sockets: live }),
      to: () => ({ emit() {} }),
    });
    handlers.timings.presenceGraceMs = 30;
    handlers.scheduleCallDisconnectCleanup = () => {};

    Object.assign(originals, {
      update: User.update,
      online: redisService.setUserOnline,
      offline: redisService.setUserOffline,
    });
    User.update = async () => [1];
    redisService.setUserOnline = async () => { redisCalls.push('online'); };
    redisService.setUserOffline = async () => { redisCalls.push('offline'); };
  });

  afterEach(() => {
    handlers.offlineTimers.forEach(clearTimeout);
    User.update = originals.update;
    redisService.setUserOnline = originals.online;
    redisService.setUserOffline = originals.offline;
  });

  test('a quick reconnect is invisible to contacts', async () => {
    const first = socketOf('s1');
    connect(first);
    await sleep(0);
    assert.deepEqual(statuses(), [true]);

    await drop(first);
    connect(socketOf('s2'));
    await sleep(60);

    assert.deepEqual(statuses(), [true]);
    assert.ok(handlers.shownOnline.has('u1'));
  });

  test('a connection that stays gone goes offline after the grace period', async () => {
    const socket = socketOf('s1');
    connect(socket);
    await drop(socket);
    await sleep(0);
    assert.deepEqual(statuses(), [true]);

    await sleep(60);

    assert.deepEqual(statuses(), [true, false]);
    assert.deepEqual([...handlers.shownOnline], []);
  });

  test('during the grace period pushes already go out: Redis says offline at once', async () => {
    const socket = socketOf('s1');
    connect(socket);
    await drop(socket);

    assert.deepEqual(redisCalls, ['online', 'offline']);
  });

  test('logout and remote sign-out go offline without waiting', async () => {
    for (const reason of ['client namespace disconnect', 'server namespace disconnect']) {
      broadcasts = [];
      const socket = socketOf('s1');
      connect(socket);
      await drop(socket, reason);
      await sleep(0);
      assert.deepEqual(statuses(), [true, false], reason);
    }
  });

  test('signing out one device keeps the user online on the other', async () => {
    const phone = socketOf('phone');
    const tablet = socketOf('tablet');
    connect(phone);
    connect(tablet);

    await drop(tablet, 'server namespace disconnect');
    await sleep(60);

    assert.deepEqual(statuses(), [true]);
  });

  test('a slow online write cannot land after the offline that followed it', async () => {
    const writes = [];
    User.update = async ({ isOnline }) => {
      await sleep(isOnline ? 20 : 0);
      writes.push(isOnline);
      return [1];
    };
    const socket = socketOf('s1');
    connect(socket);
    await drop(socket, 'client namespace disconnect');
    await sleep(50);

    assert.deepEqual(writes, [true, false]);
    assert.deepEqual(statuses(), [true, false]);
  });
});
