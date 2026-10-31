const { describe, it, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { safeFileName } = require('../utils/fileName');

require.cache[require.resolve('../services/notificationService')] = { exports: {} };
require.cache[require.resolve('../services/fcmService')] = { exports: {} };

const redisService = require('../config/redis');
const { Message, ChatParticipant, Chat } = require('../models');
const socketHandlers = require('../socket/socketHandlers');
const handlers = socketHandlers.prototype ? socketHandlers.prototype : Object.getPrototypeOf(socketHandlers);
const mediaController = require('../controllers/mediaController');
const mediaService = require('../services/mediaService');
const { authenticateToken } = require('../middleware/auth');

redisService.client.disconnect();
after(() => redisService.client.disconnect());

const fakeRes = () => ({
  statusCode: 200,
  body: undefined,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

describe('safeFileName', () => {
  it('keeps ordinary names and strips directories', () => {
    assert.equal(safeFileName('my photo (1).jpg'), 'my photo (1).jpg');
    assert.equal(safeFileName('../../databases/RKStorage'), 'RKStorage');
    assert.equal(safeFileName('..\\..\\x.txt'), 'x.txt');
    assert.equal(safeFileName('..'), 'file');
    assert.equal(safeFileName(undefined), undefined);
  });
});

describe('socket handlers survive malformed packets', () => {
  const socket = () => {
    const emitted = [];
    return {
      userId: '11111111-1111-4111-8111-111111111111',
      user: { username: 'u' },
      emitted,
      emit: (event, payload) => emitted.push([event, payload]),
      leave() {},
      to: () => ({ emit() {} }),
    };
  };
  const self = { typingUsers: new Map(), lastWaveAt: new Map(), connectedUsers: new Map() };

  for (const name of ['handleLeaveChat', 'handleTypingStart', 'handleTypingStop']) {
    it(`${name} ignores a missing or bad payload`, () => {
      for (const data of [undefined, null, {}, { chatId: 42 }, { chatId: 'x' }]) {
        assert.doesNotThrow(() => handlers[name].call(self, socket(), data));
      }
      assert.equal(self.typingUsers.size, 0);
    });
  }

  it('handleWaveSend answers a non-UUID target instead of rejecting', async () => {
    const s = socket();
    await handlers.handleWaveSend.call(self, s, { toUserId: 'x', emoji: '👋' });
    assert.ok(!s.emitted.some(([, p]) => p?.delivered === true));
  });

  it('rejects client-sent system messages', async () => {
    const s = socket();
    let ack;
    await handlers.handleSendMessage.call(self, s, { chatId: 'c', messageType: 'system', content: 'x' }, (r) => { ack = r; });
    assert.equal(ack.code, 'INVALID_MESSAGE_TYPE');
  });
});

describe('media delete ownership', () => {
  const originalDelete = mediaService.deleteFile;
  const originalFind = Message.findOne;
  afterEach(() => { mediaService.deleteFile = originalDelete; Message.findOne = originalFind; });

  const run = async (body) => {
    const deleted = [];
    mediaService.deleteFile = async (name) => { deleted.push(name); return true; };
    const res = fakeRes();
    await mediaController.deleteFile({ body, user: { id: 'me' } }, res);
    return { res, deleted };
  };

  it('deletes the caller\'s own object', async () => {
    const { res, deleted } = await run({ objectName: 'users/me/images/a.png' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(deleted, ['users/me/images/a.png']);
  });

  for (const objectName of ['users/other/images/a.png', 'apk-builds/android-release.apk', 'users/me/../other/a.png', 'firebase.json']) {
    it(`refuses ${objectName}`, async () => {
      const { res, deleted } = await run({ objectName });
      assert.equal(res.statusCode, 403);
      assert.deepEqual(deleted, []);
    });
  }

  it('refuses a forged message fileUrl pointing at the release APK', async () => {
    Message.findOne = async () => ({ fileUrl: 'x/chatapp-media/apk-builds/android-release.apk' });
    const { res, deleted } = await run({ messageId: 'm' });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(deleted, []);
  });
});

describe('JWT verification', () => {
  it('rejects a token signed with another HMAC algorithm', async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    const token = jwt.sign({ userId: 'u' }, process.env.JWT_SECRET, { algorithm: 'HS512' });
    const res = fakeRes();
    let passed = false;
    await authenticateToken({ headers: { authorization: `Bearer ${token}` } }, res, () => { passed = true; });
    assert.equal(passed, false);
  });
});

describe('removed group members', () => {
  const chatController = require('../controllers/chatController');
  const originals = { byPk: Chat.findByPk, one: ChatParticipant.findOne };
  afterEach(() => { Chat.findByPk = originals.byPk; ChatParticipant.findOne = originals.one; });

  it('cannot read full chat data', async () => {
    Chat.findByPk = async () => ({ isGroup: true, participants: [{ id: 'me' }], messages: [{ content: 'secret' }] });
    let where;
    ChatParticipant.findOne = async (q) => { where = q.where; return null; };
    const res = fakeRes();
    await chatController.getFullChatData({ params: { chatId: 'c' }, user: { id: 'me' } }, res);
    assert.equal(where.isActive, true);
    assert.notEqual(res.statusCode, 200);
    assert.equal(res.body?.chat, undefined);
  });
});
