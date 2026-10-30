// Shared by the call test files: an in-memory stand-in for the Redis call keys and the
// database rows the call code touches, plus real Socket.IO phones to talk to a real
// SocketHandlers over the wire.
const http = require('node:http');
const { Server } = require('socket.io');
const { io: connectClient } = require('socket.io-client');

// The real notification and push services open job queues and Firebase; the tests
// record what would have been pushed instead
const pushes = [];
const missedCalls = [];
const gameInvites = [];
const notificationService = {
  notifyMissedCall: async (data) => { missedCalls.push(data); },
  notifyNewMessage: async () => {},
  notifyGameInvite: async (data) => { gameInvites.push(data); },
};
require.cache[require.resolve('../../services/notificationService')] = {
  id: 'notificationService', loaded: true, exports: notificationService,
};
const fcmService = {
  sendNotification: async (userId, notification) => { pushes.push({ userId, notification }); return { success: true }; },
};
require.cache[require.resolve('../../services/fcmService')] = {
  id: 'fcmService', loaded: true, exports: fcmService,
};

const redisService = require('../../config/redis');
const { Call, User, Chat, UserBlock } = require('../../models');
const SocketHandlers = require('../../socket/socketHandlers');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Polls until `check()` is truthy; returns its value. */
async function until(check, { ms = 2000, label = 'condition' } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out after ${ms}ms waiting for ${label}`);
    await sleep(10);
  }
}

/**
 * Replaces the Redis call keys and the Call/User/Chat models with an in-memory version.
 * Names starting with "ghost" are users that don't exist.
 */
function installCallStore() {
  const store = {
    calls: new Map(),        // call:<id>
    userCalls: new Map(),    // user_call:<userId> -> { callId, status }
    pending: new Map(),      // pending_signals:<userId>:<callId> -> [signal]
    created: [],             // Call.create arguments
    callUpdates: [],         // Call.update { values, where }
    dbCalls: new Map(),      // rows for Call.findByPk
    pushes,
    missedCalls,
  };
  pushes.length = 0;
  missedCalls.length = 0;

  const originals = [];
  const stub = (object, name, replacement) => {
    originals.push([object, name, object[name]]);
    object[name] = replacement;
  };

  stub(redisService, 'getActiveCall', async (id) => (store.calls.has(id) ? { ...store.calls.get(id) } : null));
  stub(redisService, 'setActiveCall', async (id, data) => { store.calls.set(id, { ...data }); });
  stub(redisService, 'deleteActiveCall', async (id) => { store.calls.delete(id); });
  stub(redisService, 'getUserCallStatus', async (userId) => store.userCalls.get(userId) || null);
  stub(redisService, 'setUserCallStatus', async (userId, callId, status) => { store.userCalls.set(userId, { callId, status }); });
  stub(redisService, 'deleteUserCallStatus', async (userId) => { store.userCalls.delete(userId); });
  stub(redisService, 'getPendingSignals', async (userId, callId) => [...(store.pending.get(`${userId}:${callId}`) || [])]);
  stub(redisService, 'deletePendingSignals', async (userId, callId) => { store.pending.delete(`${userId}:${callId}`); });
  stub(redisService, 'pushPendingSignal', async (userId, callId, signal) => {
    const key = `${userId}:${callId}`;
    store.pending.set(key, [...(store.pending.get(key) || []), signal]);
  });
  // Nobody is blocked in these tests (blocks are covered in blocksAndPrivacy.test.js)
  stub(UserBlock, 'findAll', async () => []);
  stub(redisService, 'setUserOnline', async () => {});
  stub(redisService, 'setUserOffline', async () => {});

  stub(User, 'findByPk', async (id) => (String(id).startsWith('ghost') ? null : { id, username: id, avatar: null }));
  stub(User, 'update', async () => [1]);
  stub(Chat, 'findAll', async () => []);
  stub(Call, 'create', async (data) => { store.created.push(data); return data; });
  stub(Call, 'update', async (values, options) => { store.callUpdates.push({ values, where: options.where }); return [1]; });
  stub(Call, 'findByPk', async (id) => store.dbCalls.get(id) || null);

  return {
    store,
    restore() {
      while (originals.length) {
        const [object, name, original] = originals.pop();
        object[name] = original;
      }
    },
  };
}

/** A phone: a real socket.io-client that records every event it receives. */
class Phone {
  /**
   * @param {object} options
   * @param {boolean} options.ack answer the server's ring acknowledgement (false = an app
   *   that is connected but frozen, like one paused by Doze or MIUI battery saver)
   */
  constructor(url, userId, { ack = true } = {}) {
    this.userId = userId;
    this.ack = ack;
    this.events = [];
    this.socket = connectClient(url, {
      auth: { token: userId, syncProtocol: 2 },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    this.socket.onAny((event, ...args) => {
      this.events.push({ event, data: typeof args[0] === 'function' ? undefined : args[0], at: Date.now() });
    });
    this.socket.on('incoming_call', (_data, callback) => {
      if (this.ack && typeof callback === 'function') callback({ ok: true });
    });
  }

  connected() {
    return new Promise((resolve, reject) => {
      if (this.socket.connected) return resolve(this);
      this.socket.once('connect', () => resolve(this));
      this.socket.once('connect_error', reject);
    });
  }

  emit(event, data) {
    this.socket.emit(event, data);
  }

  /** The socket closes; the server sees this phone leave. */
  drop() {
    this.socket.disconnect();
  }

  all(event) {
    return this.events.filter(e => e.event === event).map(e => e.data);
  }

  names() {
    return this.events.map(e => e.event);
  }

  clear() {
    this.events.length = 0;
  }

  async waitFor(event, predicate = () => true, ms = 2000) {
    const found = await until(
      () => this.events.find(e => e.event === event && predicate(e.data)),
      { ms, label: `'${event}' on ${this.userId} (got: ${this.names().join(', ') || 'nothing'})` },
    );
    return found.data;
  }
}

/** A real Socket.IO server running the real SocketHandlers. */
async function startServer({ timings } = {}) {
  const httpServer = http.createServer();
  const io = new Server(httpServer);
  // A token is just the user id; sign-in has its own tests
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication error'));
    socket.userId = token;
    socket.user = { id: token, username: token };
    socket.sessionId = null;
    next();
  });
  const handlers = new SocketHandlers(io);
  if (timings) {
    handlers.timings = { ...handlers.timings, ...timings, reconnectGraceMs: { ...handlers.timings.reconnectGraceMs, ...timings.reconnectGraceMs } };
  }
  io.on('connection', (socket) => handlers.handleConnection(socket));
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}`;
  const phones = [];

  return {
    io,
    handlers,
    url,
    async phone(userId, options) {
      const phone = new Phone(url, userId, options);
      phones.push(phone);
      return phone.connected();
    },
    async close() {
      const clearTimers = () => {
        for (const timer of handlers.callTimeouts.values()) clearTimeout(timer);
        for (const timer of handlers.callDisconnectTimers.values()) clearTimeout(timer);
        handlers.callTimeouts.clear();
        handlers.callDisconnectTimers.clear();
      };
      // Tearing the phones down is not a network drop: without this the disconnect
      // timers would fire during the next test and end calls / push into its store
      clearTimers();
      handlers.scheduleCallDisconnectCleanup = async () => {};
      phones.forEach(phone => phone.socket.disconnect());
      // Rings still waiting for an acknowledgement finish while the stubs are in place
      await sleep(handlers.timings.ringAckTimeoutMs + 40);
      clearTimers();
      await new Promise(resolve => io.close(resolve));
    },
  };
}

module.exports = { gameInvites, installCallStore, startServer, Phone, sleep, until, redisService };
