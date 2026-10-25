const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { OAuth2Client } = require('google-auth-library');

const { User, Chat, ChatParticipant, GroupChatKey, EncryptionSession } = require('../models');
const { resetDeviceKey } = require('../controllers/authController');

const KEY = '-----BEGIN RSA PUBLIC KEY-----' + 'N'.repeat(300) + '-----END RSA PUBLIC KEY-----';

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

describe('resetDeviceKey (start fresh)', () => {
  let user;
  let retired;

  const call = async (body) => {
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    await resetDeviceKey({ user: { id: 'u1' }, body: { publicKey: KEY, idToken: 'google-token', ...body } }, res);
    return res;
  };

  beforeEach(() => {
    retired = { sessions: null, groupKeys: [], groups: [] };
    user = {
      id: 'u1',
      googleId: 'google-sub-1',
      encryptedPrivateKey: null,
      publicKey: 'OLD',
      rotateKeys: async function (publicKey, encryptedPrivateKey, keySalt, keyIv) {
        this.rotatedWith = [publicKey, encryptedPrivateKey, keySalt, keyIv];
        this.publicKey = publicKey;
      },
    };
    stub(User, 'findByPk', async () => user);
    stub(OAuth2Client.prototype, 'verifyIdToken', async () => ({ getPayload: () => ({ sub: 'google-sub-1' }) }));
    stub(EncryptionSession, 'update', async (_fields, options) => { retired.sessions = options.where; });
    stub(ChatParticipant, 'findAll', async () => [{ chatId: 'g1' }]);
    stub(Chat, 'findAll', async () => [{ id: 'g1', settings: {}, update: async (f) => retired.groups.push(f) }]);
    stub(GroupChatKey, 'destroy', async ({ where }) => { retired.groupKeys.push(where); });
  });

  test('swaps in the new public key after a fresh Google confirmation, and has groups re-key', async () => {
    const res = await call({});

    assert.equal(res.statusCode, 200);
    assert.deepEqual(user.rotatedWith, [KEY, null, null, null]);
    assert.deepEqual(res.body.user, { publicKey: KEY, encryptionEnabled: true, hasKeyBackup: false });
    assert.deepEqual(retired.sessions, { userId: 'u1' });
    assert.deepEqual(retired.groupKeys, [{ chatId: 'g1', userId: 'u1' }]);
    assert.deepEqual(retired.groups, [{ settings: { keyRotationNeeded: true } }]);
  });

  test('needs a Google confirmation, so a stolen session alone cannot swap the keys', async () => {
    const res = await call({ idToken: undefined });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'GOOGLE_CONFIRMATION_REQUIRED');
    assert.equal(user.rotatedWith, undefined);
  });

  test('refuses a Google confirmation from a different Google account', async () => {
    OAuth2Client.prototype.verifyIdToken = async () => ({ getPayload: () => ({ sub: 'someone-else' }) });

    const res = await call({});

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'GOOGLE_ACCOUNT_MISMATCH');
    assert.equal(user.rotatedWith, undefined);
  });

  test('refuses an invalid Google token', async () => {
    OAuth2Client.prototype.verifyIdToken = async () => { throw new Error('bad token'); };

    const res = await call({});

    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'GOOGLE_CONFIRMATION_FAILED');
    assert.equal(user.rotatedWith, undefined);
  });

  test('sends accounts with a password backup to their password instead (keeps their messages)', async () => {
    user.encryptedPrivateKey = 'WRAPPED';

    const res = await call({});

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'HAS_PASSWORD_BACKUP');
    assert.equal(user.rotatedWith, undefined);
  });

  test('rejects a malformed key', async () => {
    for (const bad of [undefined, 'short', 'x'.repeat(5000)]) {
      const res = await call({ publicKey: bad });
      assert.equal(res.statusCode, 400);
    }
    assert.equal(user.rotatedWith, undefined);
  });
});
