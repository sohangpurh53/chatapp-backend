const { test, describe, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');

// The real notification service opens job queues on Redis that never let the
// test process exit; push notifications aren't what these tests are about
const notificationService = { notifyNewMessage: async () => {} };
require.cache[require.resolve('../services/notificationService')] = {
  id: 'notificationService', loaded: true, exports: notificationService,
};

const { Chat, ChatParticipant, Message, MessageReceipt, UserMessageDeletion } = require('../models');
const { syncMessages, getChatMessages, clearChat } = require('../controllers/chatController');
const redisService = require('../config/redis');
const SocketHandlers = require('../socket/socketHandlers');

// The Redis client connects as soon as it's loaded; nothing here needs it
redisService.client.disconnect();
after(() => redisService.client.disconnect());

// Replaces methods for one test and puts them back afterwards
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

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_NEW = '33333333-3333-4333-8333-333333333333';

const row = (data) => ({ ...data, toJSON: () => ({ ...data }) });

describe('GET /chat/sync', () => {
  let findAllArgs;

  const call = async (query) => {
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    await syncMessages({ user: { id: 'me' }, query }, res);
    return res;
  };

  beforeEach(() => {
    findAllArgs = null;
    stub(ChatParticipant, 'findAll', async () => [{ chatId: 'c1' }, { chatId: 'c2' }]);
    stub(UserMessageDeletion, 'findAll', async () => [{ messageId: 'gone' }]);
  });

  test('a device without a cursor gets one starting now, and no messages', async () => {
    stub(Message, 'findAll', async () => { throw new Error('should not query'); });
    const before = Date.now();
    const res = await call({});
    assert.deepEqual(res.body.messages, []);
    assert.equal(res.body.hasMore, false);
    assert.ok(new Date(res.body.cursor.since).getTime() >= before);
    assert.equal(res.body.cursor.sinceId, '00000000-0000-0000-0000-000000000000');
  });

  test('rejects a cursor that is not a date', async () => {
    const res = await call({ since: 'yesterday-ish' });
    assert.equal(res.statusCode, 400);
  });

  test('pages through every chat after the cursor, oldest first, without messages you deleted', async () => {
    stub(Message, 'findAll', async (args) => {
      findAllArgs = args;
      return [
        row({ id: ID_A, chatId: 'c1', createdAt: new Date('2026-10-01T10:00:00.000Z'), isEncrypted: false }),
        row({ id: ID_B, chatId: 'c2', createdAt: new Date('2026-10-01T10:00:01.000Z'), isEncrypted: false }),
        row({ id: ID_NEW, chatId: 'c1', createdAt: new Date('2026-10-01T10:00:02.000Z'), isEncrypted: false }),
      ];
    });

    const res = await call({ since: '2026-10-01T09:00:00.000Z', sinceId: ID_A, limit: '2' });

    assert.equal(res.statusCode, 200);
    // One extra row tells there is more; it is not returned
    assert.equal(findAllArgs.limit, 3);
    assert.deepEqual(res.body.messages.map(m => m.id), [ID_A, ID_B]);
    assert.equal(res.body.hasMore, true);
    // The next page starts right after the last message returned
    assert.deepEqual(res.body.cursor, { since: '2026-10-01T10:00:01.000Z', sinceId: ID_B });
    assert.deepEqual(findAllArgs.order, [['createdAt', 'ASC'], ['id', 'ASC']]);

    const { Op } = require('sequelize');
    assert.deepEqual(findAllArgs.where.chatId[Op.in], ['c1', 'c2']);
    assert.deepEqual(findAllArgs.where.id[Op.notIn], ['gone']);
    const [after, sameMoment] = findAllArgs.where[Op.or];
    assert.equal(after.createdAt[Op.gt].toISOString(), '2026-10-01T09:00:00.000Z');
    assert.equal(sameMoment.id[Op.gt], ID_A);
  });

  test('an empty page keeps the cursor where it was', async () => {
    stub(Message, 'findAll', async () => []);
    const res = await call({ since: '2026-10-01T09:00:00.000Z', sinceId: ID_A });
    assert.deepEqual(res.body, {
      messages: [],
      hasMore: false,
      cursor: { since: '2026-10-01T09:00:00.000Z', sinceId: ID_A },
    });
  });

  test('page size is capped', async () => {
    stub(Message, 'findAll', async (args) => { findAllArgs = args; return []; });
    await call({ since: '2026-10-01T09:00:00.000Z', limit: '100000' });
    assert.equal(findAllArgs.limit, 201);
  });
});

describe('send_message with a client message id', () => {
  let handlers;
  let emitted;
  let roomEmits;
  let created;
  let receipts;
  let sockets;

  const socket = () => ({
    userId: 'me',
    user: { username: 'me' },
    data: { syncProtocol: 2 },
    emit: (event, data) => emitted.push({ event, data }),
    join: () => {},
  });

  const send = (data) => new Promise((resolve) => {
    handlers.handleSendMessage(socket(), { chatId: 'c1', isEncrypted: false, content: 'hi', ...data }, resolve);
  });

  beforeEach(() => {
    emitted = [];
    roomEmits = [];
    created = null;
    receipts = null;
    sockets = new Map();
    const io = {
      to: (room) => ({ emit: (event, data) => roomEmits.push({ room, event, data }) }),
      in: () => ({ socketsJoin: () => {} }),
      sockets: { sockets },
    };
    handlers = new SocketHandlers(io);

    stub(redisService, 'getUserOnlineStatus', async () => true);
    stub(notificationService, 'notifyNewMessage', async () => {});
    stub(ChatParticipant, 'findOne', async () => ({ role: 'member' }));
    stub(ChatParticipant, 'update', async () => [0]);
    stub(Chat, 'findByPk', async () => ({ id: 'c1', isGroup: true, settings: {} }));
    stub(Chat, 'update', async () => [1]);
    stub(ChatParticipant, 'findAll', async () => [{ userId: 'legacy' }, { userId: 'modern' }, { userId: 'offline' }]);
    stub(MessageReceipt, 'bulkCreate', async (rows) => { receipts = rows; });
    stub(Message, 'create', async (data) => {
      created = data;
      return { ...data, id: data.id || 'server-made', createdAt: new Date('2026-10-01T10:00:00.000Z') };
    });
    stub(Message, 'findByPk', async (id, options) => {
      // The duplicate check asks for a few columns; the broadcast fetch for everything
      if (options?.attributes && Array.isArray(options.attributes)) return null;
      return {
        sender: { id: 'me' },
        toJSON: () => ({ id, chatId: 'c1', senderId: 'me', isEncrypted: false }),
      };
    });

    handlers.connectedUsers.set('legacy', 'sock-legacy');
    handlers.connectedUsers.set('modern', 'sock-modern');
    sockets.set('sock-legacy', { data: { syncProtocol: 1 } });
    sockets.set('sock-modern', { data: { syncProtocol: 2 } });
  });

  test('stores the message under the id the app made and acknowledges it', async () => {
    const ack = await send({ clientMessageId: ID_NEW });

    assert.equal(created.id, ID_NEW);
    assert.equal(ack.ok, true);
    assert.equal(ack.messageId, ID_NEW);
    assert.equal(ack.duplicate, false);
    assert.equal(ack.createdAt, '2026-10-01T10:00:00.000Z');
    const sent = emitted.find(e => e.event === 'message_sent');
    assert.equal(sent.data.clientMessageId, ID_NEW);
    assert.ok(roomEmits.some(e => e.event === 'new_message' && e.room === 'chat_c1'));
  });

  test('"delivered" only for a connected app that cannot confirm it; everyone else starts at "sent"', async () => {
    await send({ clientMessageId: ID_NEW });
    const byUser = Object.fromEntries(receipts.map(r => [r.userId, r.status]));
    assert.deepEqual(byUser, { legacy: 'delivered', modern: 'sent', offline: 'sent' });
  });

  test('the same message sent again is acknowledged, not stored twice', async () => {
    stub(Message, 'findByPk', async () => ({ id: ID_A, senderId: 'me', chatId: 'c1', createdAt: new Date('2026-10-01T09:00:00.000Z') }));
    stub(Message, 'create', async () => { throw new Error('must not store again'); });

    const ack = await send({ clientMessageId: ID_A });

    assert.deepEqual(
      { ok: ack.ok, duplicate: ack.duplicate, messageId: ack.messageId, createdAt: ack.createdAt },
      { ok: true, duplicate: true, messageId: ID_A, createdAt: '2026-10-01T09:00:00.000Z' }
    );
    assert.ok(!roomEmits.some(e => e.event === 'new_message'), 'not broadcast a second time');
  });

  test("another person's message id is refused", async () => {
    stub(Message, 'findByPk', async () => ({ id: ID_A, senderId: 'someone-else', chatId: 'c1' }));
    const ack = await send({ clientMessageId: ID_A });
    assert.equal(ack.ok, false);
    assert.equal(ack.code, 'MESSAGE_ID_CONFLICT');
    assert.equal(ack.retryable, false);
  });

  test('an id that is not a UUID is refused', async () => {
    const ack = await send({ clientMessageId: 'not-a-uuid' });
    assert.equal(ack.ok, false);
    assert.equal(ack.code, 'INVALID_MESSAGE_ID');
  });

  test('two copies racing: the one that loses the insert is acknowledged as a duplicate', async () => {
    let lookups = 0;
    stub(Message, 'findByPk', async (id, options) => {
      lookups++;
      // First lookup: not stored yet. After the failed insert: the other copy is there
      if (lookups === 1) return null;
      return { id: ID_NEW, senderId: 'me', chatId: 'c1', createdAt: new Date('2026-10-01T10:00:00.000Z') };
    });
    stub(Message, 'create', async () => {
      const error = new Error('duplicate key');
      error.name = 'SequelizeUniqueConstraintError';
      throw error;
    });

    const ack = await send({ clientMessageId: ID_NEW });
    assert.equal(ack.ok, true);
    assert.equal(ack.duplicate, true);
  });

  test('slow mode is reported as worth retrying, with when', async () => {
    stub(Chat, 'findByPk', async () => ({ id: 'c1', isGroup: true, settings: { slowModeSeconds: 30 } }));
    stub(Message, 'findOne', async () => ({ createdAt: new Date(Date.now() - 10 * 1000) }));

    const ack = await send({ clientMessageId: ID_NEW });

    assert.equal(ack.ok, false);
    assert.equal(ack.code, 'SLOW_MODE');
    assert.equal(ack.retryable, true);
    assert.ok(ack.retryAfter >= 19 && ack.retryAfter <= 20);
    // Older apps still get the error event, tagged so the outbox can match it
    assert.equal(emitted.find(e => e.event === 'error').data.clientMessageId, ID_NEW);
  });

  test('a database failure is worth retrying', async () => {
    stub(Message, 'create', async () => { throw new Error('connection terminated'); });
    const ack = await send({ clientMessageId: ID_NEW });
    assert.equal(ack.ok, false);
    assert.equal(ack.code, 'SEND_FAILED');
    assert.equal(ack.retryable, true);
  });

  test('older apps without an id or callback still work', async () => {
    await new Promise((resolve) => {
      handlers.handleSendMessage(socket(), { chatId: 'c1', content: 'hi' }).then(resolve);
    });
    assert.equal(created.id, undefined);
    assert.equal(emitted.find(e => e.event === 'message_sent').data.messageId, 'server-made');
  });
});

describe('messages_delivered', () => {
  let handlers;
  let roomEmits;
  let updated;

  beforeEach(() => {
    roomEmits = [];
    updated = null;
    handlers = new SocketHandlers({
      to: (room) => ({ emit: (event, data) => roomEmits.push({ room, event, data }) }),
    });
  });

  test("marks the user's own pending receipts delivered and tells each sender", async () => {
    const { Op } = require('sequelize');
    let receiptQuery;
    stub(MessageReceipt, 'findAll', async (args) => {
      receiptQuery = args;
      return [{ id: 'r1', messageId: ID_A }];
    });
    stub(MessageReceipt, 'update', async (fields, options) => { updated = { fields, options }; });
    stub(Message, 'findAll', async () => [{ id: ID_A, chatId: 'c1', senderId: 'alice' }]);

    await handlers.handleMessagesDelivered(
      { userId: 'me' },
      { messageIds: [ID_A, ID_A, 'junk', ID_B] }
    );

    assert.equal(receiptQuery.where.userId, 'me');
    assert.deepEqual(receiptQuery.where.messageId[Op.in], [ID_A, ID_B]);
    assert.deepEqual(receiptQuery.where.status[Op.in], ['pending', 'sent']);
    assert.equal(updated.fields.status, 'delivered');
    assert.deepEqual(updated.options.where.id[Op.in], ['r1']);
    assert.equal(roomEmits.length, 1);
    assert.equal(roomEmits[0].room, 'user_alice');
    assert.equal(roomEmits[0].event, 'message_delivered');
    assert.equal(roomEmits[0].data.userId, 'me');
  });

  test('nothing to do for receipts already delivered or read', async () => {
    stub(MessageReceipt, 'findAll', async () => []);
    stub(MessageReceipt, 'update', async () => { throw new Error('should not update'); });
    await handlers.handleMessagesDelivered({ userId: 'me' }, { messageIds: [ID_A] });
    assert.equal(roomEmits.length, 0);
  });
});

describe('GET /chat/:chatId/messages with a before cursor', () => {
  test('returns the messages just before the given one, newest last', async () => {
    let args;
    stub(ChatParticipant, 'findOne', async () => ({ id: 'p' }));
    stub(UserMessageDeletion, 'findAll', async () => []);
    stub(Message, 'findAll', async (a) => {
      args = a;
      return [row({ id: ID_B, createdAt: new Date('2026-10-01T10:00:01Z') }), row({ id: ID_A, createdAt: new Date('2026-10-01T10:00:00Z') })];
    });
    const res = { status() { return this; }, json(body) { this.body = body; return this; } };

    await getChatMessages({
      user: { id: 'me' },
      params: { chatId: 'c1' },
      query: { limit: '50', before: '2026-10-01T10:00:02.000Z', beforeId: ID_NEW },
    }, res);

    const { Op } = require('sequelize');
    assert.equal(args.offset, 0);
    assert.deepEqual(args.order, [['createdAt', 'DESC'], ['id', 'DESC']]);
    const [earlier, sameMoment] = args.where[Op.and][0][Op.or];
    assert.equal(earlier.createdAt[Op.lt].toISOString(), '2026-10-01T10:00:02.000Z');
    assert.equal(sameMoment.id[Op.lt], ID_NEW);
    assert.deepEqual(res.body.messages.map(m => m.id), [ID_A, ID_B]);
  });
});

describe('DELETE /chat/:chatId/clear with a before cutoff', () => {
  test('clears only messages up to the cutoff (cleared offline, sent later)', async () => {
    let query;
    let created;
    stub(Chat, 'findByPk', async () => ({ id: 'c1' }));
    stub(Message, 'findAll', async (args) => { query = args; return [{ id: ID_A }]; });
    stub(UserMessageDeletion, 'bulkCreate', async (rows) => { created = rows; });
    const res = { status() { return this; }, json(body) { this.body = body; return this; } };

    await clearChat({ user: { id: 'me' }, params: { chatId: 'c1' }, query: { before: '2026-10-01T10:00:05.000Z' } }, res);

    const { Op } = require('sequelize');
    assert.equal(query.where.chatId, 'c1');
    assert.equal(query.where.createdAt[Op.lte].toISOString(), '2026-10-01T10:00:05.000Z');
    assert.deepEqual(created.map(r => r.messageId), [ID_A]);
    assert.equal(res.body.deletedCount, 1);
  });

  test('without a cutoff, the whole chat as before', async () => {
    let query;
    stub(Chat, 'findByPk', async () => ({ id: 'c1' }));
    stub(Message, 'findAll', async (args) => { query = args; return []; });
    const res = { status() { return this; }, json(body) { this.body = body; return this; } };
    await clearChat({ user: { id: 'me' }, params: { chatId: 'c1' }, query: {} }, res);
    assert.deepEqual(query.where, { chatId: 'c1' });
  });
});
