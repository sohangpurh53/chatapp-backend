const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { Chat, ChatParticipant, Message, UserMessageDeletion } = require('../models');
const { getUserChats } = require('../controllers/chatController');

// Replaces model methods for one test and puts them back afterwards
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

const call = async () => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  await getUserChats({ user: { id: 'me' } }, res);
  return res;
};

const chatRow = (id, lastMessage) => {
  const data = { id, isGroup: false, participants: [], messages: lastMessage ? [lastMessage] : [] };
  return { ...data, toJSON: () => JSON.parse(JSON.stringify(data)) };
};

describe('getUserChats', () => {
  let participations;
  let deletions;

  beforeEach(() => {
    participations = [];
    deletions = [];
    stub(ChatParticipant, 'findAll', async () => participations);
    stub(UserMessageDeletion, 'findAll', async ({ where }) =>
      deletions.filter(d => d.userId === where.userId).map(d => ({ messageId: d.messageId })));
  });

  test('tells you whether you muted each chat, and until when', async () => {
    const future = new Date(Date.now() + 3600 * 1000);
    participations = [
      { chatId: 'muted', isMuted: true, mutedUntil: null },
      { chatId: 'until', isMuted: true, mutedUntil: future },
      { chatId: 'expired', isMuted: true, mutedUntil: new Date(Date.now() - 1000) },
      { chatId: 'open', isMuted: false, mutedUntil: null },
    ];
    stub(Chat, 'findAll', async () => ['muted', 'until', 'expired', 'open'].map(id => chatRow(id)));

    const res = await call();
    const byId = Object.fromEntries(res.body.chats.map(c => [c.id, c]));

    assert.equal(byId.muted.isMuted, true);
    assert.equal(byId.muted.mutedUntil, null);
    assert.equal(byId.until.isMuted, true);
    assert.equal(new Date(byId.until.mutedUntil).getTime(), future.getTime());
    assert.equal(byId.expired.isMuted, false, 'a mute that ran out is over');
    assert.equal(byId.open.isMuted, false);
  });

  test('never previews a message you deleted, showing the newest one you kept instead', async () => {
    participations = [{ chatId: 'c1', isMuted: false }];
    deletions = [{ userId: 'me', messageId: 'old-last' }];
    stub(Chat, 'findAll', async () => [chatRow('c1', { id: 'old-last', content: 'deleted text', isEncrypted: false })]);
    stub(Message, 'findOne', async () => ({ toJSON: () => ({ id: 'kept', content: 'still here', isEncrypted: false }) }));

    const res = await call();

    assert.equal(res.body.chats[0].messages[0].id, 'kept');
  });

  test('shows no preview when you deleted every message', async () => {
    participations = [{ chatId: 'c1', isMuted: false }];
    deletions = [{ userId: 'me', messageId: 'old-last' }];
    stub(Chat, 'findAll', async () => [chatRow('c1', { id: 'old-last', content: 'deleted text', isEncrypted: false })]);
    stub(Message, 'findOne', async () => null);

    const res = await call();

    assert.deepEqual(res.body.chats[0].messages, []);
  });

  test('leaves previews alone when nothing was deleted', async () => {
    participations = [{ chatId: 'c1', isMuted: false }];
    stub(Chat, 'findAll', async () => [chatRow('c1', { id: 'latest', content: 'hello', isEncrypted: false })]);
    stub(Message, 'findOne', async () => { throw new Error('should not look for another message'); });

    const res = await call();

    assert.equal(res.body.chats[0].messages[0].id, 'latest');
  });

  test('hands encrypted previews over as objects, not raw JSON text', async () => {
    participations = [{ chatId: 'c1', isMuted: false }];
    const payload = { encryptedContent: 'cipher', encryptedKey: 'key', iv: 'iv' };
    stub(Chat, 'findAll', async () => [chatRow('c1', { id: 'm1', isEncrypted: true, encryptedContent: JSON.stringify(payload) })]);

    const res = await call();

    assert.deepEqual(res.body.chats[0].messages[0].encryptedContent, payload);
  });
});
