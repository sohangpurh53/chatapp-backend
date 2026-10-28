const { test, describe, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');

console.log = () => {};

const notificationService = { notifyMissedCall: async () => {}, notifyNewMessage: async () => { sentNotifications += 1; } };
let sentNotifications = 0;
require.cache[require.resolve('../services/notificationService')] = {
  id: 'notificationService', loaded: true, exports: notificationService,
};
require.cache[require.resolve('../services/fcmService')] = {
  id: 'fcmService', loaded: true, exports: { sendNotification: async () => ({ success: true }) },
};

const { User, Chat, Message, ChatParticipant, UserBlock, Call } = require('../models');
const redisService = require('../config/redis');
const SocketHandlers = require('../socket/socketHandlers');

redisService.client.disconnect();
after(() => redisService.client.disconnect());

const stubs = [];
const stub = (object, name, replacement) => { stubs.push([object, name, object[name]]); object[name] = replacement; };
afterEach(() => { while (stubs.length) { const [o, n, v] = stubs.pop(); o[n] = v; } });

const CHAT = { id: 'chat1', isGroup: false, participant1Id: 'alice', participant2Id: 'bob' };
const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';

describe('being blocked is never revealed to the sender', () => {
  let handlers;
  let roomEmits;
  let created;

  const socketFor = (userId) => {
    const emitted = [];
    return { userId, user: { username: userId }, emitted, emit: (event, data) => emitted.push({ event, data }), to: () => ({ emit: () => {} }) };
  };
  // blocks: list of [blockerId, blockedId]
  const blockRows = (blocks) => {
    stub(UserBlock, 'findAll', async ({ where }) => {
      const sym = Object.getOwnPropertySymbols(where)[0];
      const pairs = where[sym];
      return blocks
        .filter(([a, b]) => pairs.some(p => p.blockerId === a && p.blockedId === b))
        .map(([a]) => ({ blockerId: a }));
    });
  };

  beforeEach(() => {
    roomEmits = [];
    created = 0;
    sentNotifications = 0;
    handlers = new SocketHandlers({
      to: (room) => ({ emit: (event, data) => roomEmits.push({ room, event, data }), timeout: () => ({ emit: () => {} }) }),
      emit: () => {},
      sockets: { adapter: { rooms: new Map() } },
      of: () => ({ sockets: new Map() }),
    });
    stub(Message, 'findByPk', async () => null);
    stub(Message, 'create', async () => { created += 1; return {}; });
    stub(ChatParticipant, 'findOne', async () => ({ role: 'member' }));
    stub(Chat, 'findByPk', async () => CHAT);
    stub(User, 'findByPk', async (id) => ({ id, username: id, avatar: null }));
    stub(Call, 'create', async () => { throw new Error('a shadow call must not touch the database'); });
  });

  const send = async (from) => {
    const socket = socketFor(from);
    let ack;
    await handlers.handleSendMessage(socket, { chatId: 'chat1', content: 'hi', clientMessageId: MESSAGE_ID }, (r) => { ack = r; });
    return { socket, ack };
  };

  test('a blocked sender gets a normal "sent" acknowledgement, and nothing is stored or delivered', async () => {
    blockRows([['bob', 'alice']]); // bob blocked alice
    const { socket, ack } = await send('alice');

    assert.equal(ack.ok, true);
    assert.equal(ack.messageId, MESSAGE_ID);
    assert.ok(socket.emitted.some(e => e.event === 'message_sent'));
    assert.ok(!socket.emitted.some(e => e.event === 'error'));
    assert.equal(created, 0);
    assert.equal(roomEmits.length, 0);
    assert.equal(sentNotifications, 0);
  });

  test('the person who did the blocking is told plainly', async () => {
    blockRows([['alice', 'bob']]); // alice blocked bob
    const { ack } = await send('alice');

    assert.equal(ack.ok, false);
    assert.equal(ack.code, 'USER_BLOCKED');
  });

  test('a call to someone who blocked you rings like an unanswered call and never reaches them', async () => {
    blockRows([['bob', 'alice']]);
    handlers.timings.ringTimeoutMs = 20;
    const caller = socketFor('alice');

    await handlers.handleInitiateCall(caller, { receiverId: 'bob', callType: 'voice' });

    const started = caller.emitted.find(e => e.event === 'call_initiated');
    assert.ok(started, 'the caller sees the call start');
    assert.ok(!caller.emitted.some(e => e.event === 'call_error'));
    assert.equal(started.data.status, 'calling');
    assert.equal(roomEmits.filter(e => e.room === 'user_bob').length, 0);

    await new Promise(r => setTimeout(r, 60));
    assert.ok(roomEmits.some(e => e.room === 'user_alice' && e.event === 'call_missed' && e.data.callId === started.data.callId));
    assert.equal(roomEmits.filter(e => e.room === 'user_bob').length, 0);
  });

  test('hanging up a shadow call ends it for the caller and cancels the missed timer', async () => {
    blockRows([['bob', 'alice']]);
    const caller = socketFor('alice');
    await handlers.handleInitiateCall(caller, { receiverId: 'bob', callType: 'voice' });
    const { callId } = caller.emitted.find(e => e.event === 'call_initiated').data;

    await handlers.handleEndCall(caller, { callId });

    assert.ok(caller.emitted.some(e => e.event === 'call_ended' && e.data.callId === callId));
    assert.equal(handlers.shadowCalls.size, 0);
  });

  test('the person who blocked gets an explicit call error', async () => {
    blockRows([['alice', 'bob']]);
    const caller = socketFor('alice');
    await handlers.handleInitiateCall(caller, { receiverId: 'bob', callType: 'voice' });
    assert.equal(caller.emitted.find(e => e.event === 'call_error').data.code, 'USER_BLOCKED');
  });
});
