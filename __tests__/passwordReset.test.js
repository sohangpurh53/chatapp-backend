const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { User, PasswordReset, Chat, ChatParticipant, GroupChatKey, EncryptionSession } = require('../models');
const mailer = require('../services/mailer');
const sessionService = require('../services/sessionService');
const passwordReset = require('../services/passwordReset');
const { forgotPassword, resetPassword } = require('../controllers/authController');

const KEY = 'K'.repeat(300);

// Replaces model/service methods for one test and puts them back afterwards
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

const makeRes = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
});

const makeUser = (extra = {}) => {
  const user = {
    id: 'u1',
    email: 'jamie@gmail.com',
    password: 'hash',
    encryptionEnabled: false,
    update: async function (fields) { Object.assign(this, fields); },
    rotateKeys: async function (...args) { this.rotatedWith = args; },
    ...extra,
  };
  return user;
};

describe('reset codes', () => {
  test('are six digits and differ between users', () => {
    for (let i = 0; i < 50; i += 1) assert.match(passwordReset.generateCode(), /^\d{6}$/);
    assert.notEqual(passwordReset.hashCode('u1', '123456'), passwordReset.hashCode('u2', '123456'));
    assert.equal(passwordReset.hashCode('u1', '123456'), passwordReset.hashCode('u1', '123456'));
  });
});

describe('requestReset', () => {
  let sent;
  let created;
  beforeEach(() => {
    sent = [];
    created = [];
    stub(mailer, 'sendMail', async (mail) => { sent.push(mail); return { delivered: true }; });
    stub(PasswordReset, 'findOne', async () => null);
    stub(PasswordReset, 'destroy', async () => 0);
    stub(PasswordReset, 'create', async (row) => { created.push(row); return row; });
  });

  test('emails a code and stores only its hash', async () => {
    stub(User, 'findOne', async () => makeUser());

    const result = await passwordReset.requestReset('Jamie@Gmail.com');

    assert.equal(result.sent, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'jamie@gmail.com');
    const code = sent[0].text.match(/\b(\d{6})\b/)[1];
    assert.equal(created[0].codeHash, passwordReset.hashCode('u1', code));
    assert.ok(!JSON.stringify(created[0]).includes(code), 'the plain code must not be stored');
    assert.ok(created[0].expiresAt > new Date());
  });

  test('says nothing for an unknown address', async () => {
    stub(User, 'findOne', async () => null);

    assert.deepEqual(await passwordReset.requestReset('nobody@x.com'), { sent: false });
    assert.equal(sent.length, 0);
  });

  test('has nothing to reset for a Google-only account', async () => {
    stub(User, 'findOne', async () => makeUser({ password: null }));

    assert.deepEqual(await passwordReset.requestReset('jamie@gmail.com'), { sent: false });
    assert.equal(sent.length, 0);
  });

  test('does not send another code inside the cooldown', async () => {
    stub(User, 'findOne', async () => makeUser());
    PasswordReset.findOne = async () => ({ createdAt: new Date(Date.now() - 10 * 1000) });

    assert.deepEqual(await passwordReset.requestReset('jamie@gmail.com'), { sent: false });
    assert.equal(sent.length, 0);
  });
});

describe('verifyCode', () => {
  const live = (extra = {}) => {
    const reset = {
      attempts: 0,
      codeHash: passwordReset.hashCode('u1', '123456'),
      update: async function (fields) { Object.assign(this, fields); },
      ...extra,
    };
    stub(PasswordReset, 'findOne', async () => reset);
    return reset;
  };

  test('accepts the right code without spending it', async () => {
    const reset = live();

    assert.equal(await passwordReset.verifyCode('u1', '123456'), reset);
    assert.equal(reset.usedAt, undefined);
  });

  test('counts wrong guesses and rejects them', async () => {
    const reset = live();

    assert.equal(await passwordReset.verifyCode('u1', '000000'), null);
    assert.equal(reset.attempts, 1);
  });

  test('locks after too many wrong guesses, even for the right code', async () => {
    live({ attempts: passwordReset.MAX_ATTEMPTS });

    assert.equal(await passwordReset.verifyCode('u1', '123456'), null);
  });

  test('rejects anything that is not six digits without touching the database', async () => {
    stub(PasswordReset, 'findOne', async () => { throw new Error('should not query'); });

    for (const bad of [undefined, null, '', '12345', '1234567', 'abcdef', 123456, {}]) {
      assert.equal(await passwordReset.verifyCode('u1', bad), null);
    }
  });

  test('finds nothing for a used or expired code', async () => {
    stub(PasswordReset, 'findOne', async () => null);

    assert.equal(await passwordReset.verifyCode('u1', '123456'), null);
  });
});

describe('forgotPassword endpoint', () => {
  test('answers the same whether or not the account exists', async () => {
    stub(passwordReset, 'requestReset', async () => ({ sent: false }));
    const known = makeRes();
    const unknown = makeRes();

    await forgotPassword({ body: { email: 'jamie@gmail.com' } }, known);
    stub(passwordReset, 'requestReset', async () => { throw new Error('smtp down'); });
    await forgotPassword({ body: { email: 'nobody@x.com' } }, unknown);

    assert.equal(known.statusCode, 200);
    assert.equal(unknown.statusCode, 200);
    assert.deepEqual(known.body, unknown.body);
  });

  test('needs an email', async () => {
    const res = makeRes();

    await forgotPassword({ body: {} }, res);

    assert.equal(res.statusCode, 400);
  });
});

describe('resetPassword endpoint', () => {
  let user;
  let reset;
  let used;
  let revoked;
  let droppedKeys;
  let groupUpdates;
  let deactivated;

  const call = async (body) => {
    const res = makeRes();
    await resetPassword({ body: { email: 'jamie@gmail.com', code: '123456', newPassword: 'newpass1', ...body } }, res);
    return res;
  };

  beforeEach(() => {
    user = makeUser();
    reset = { id: 'r1' };
    used = false;
    revoked = null;
    droppedKeys = [];
    groupUpdates = [];
    deactivated = null;
    stub(User, 'findOne', async () => user);
    stub(passwordReset, 'verifyCode', async (_id, code) => (code === '123456' ? reset : null));
    stub(passwordReset, 'useUp', async () => { used = true; });
    stub(sessionService, 'revokeOthers', async (userId, except) => { revoked = { userId, except }; return 2; });
    stub(EncryptionSession, 'update', async (fields, options) => { deactivated = { fields, options }; });
    stub(ChatParticipant, 'findAll', async () => [{ chatId: 'g1' }, { chatId: 'g2' }]);
    stub(Chat, 'findAll', async () => [
      { id: 'g1', settings: { onlyAdminsCanSend: true }, update: async (fields) => groupUpdates.push(['g1', fields]) },
      { id: 'g2', settings: null, update: async (fields) => groupUpdates.push(['g2', fields]) },
    ]);
    stub(GroupChatKey, 'destroy', async (options) => { droppedKeys.push(options.where); });
  });

  test('changes the password, signs every device out and spends the code', async () => {
    const res = await call({});

    assert.equal(res.statusCode, 200);
    assert.equal(user.password, 'newpass1');
    assert.deepEqual(revoked, { userId: 'u1', except: null });
    assert.equal(used, true);
    assert.deepEqual(res.body, { success: true, userId: 'u1', keysReplaced: false });
  });

  test('replaces the keys of an encrypted account and has groups rotate theirs', async () => {
    user.encryptionEnabled = true;

    const res = await call({ publicKey: KEY, encryptedPrivateKey: KEY, keySalt: 'salt', keyIv: 'iv' });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(user.rotatedWith, [KEY, KEY, 'salt', 'iv']);
    assert.equal(res.body.keysReplaced, true);
    assert.deepEqual(deactivated.options.where, { userId: 'u1' });
    assert.deepEqual(droppedKeys, [{ chatId: 'g1', userId: 'u1' }, { chatId: 'g2', userId: 'u1' }]);
    assert.deepEqual(groupUpdates, [
      ['g1', { settings: { onlyAdminsCanSend: true, keyRotationNeeded: true } }],
      ['g2', { settings: { keyRotationNeeded: true } }],
    ]);
  });

  test('refuses an encrypted account without new keys, and keeps the code usable', async () => {
    user.encryptionEnabled = true;

    const res = await call({});

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'KEYS_REQUIRED');
    assert.equal(user.password, 'hash');
    assert.equal(used, false);
  });

  test('rejects a wrong code and changes nothing', async () => {
    const res = await call({ code: '000000' });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'INVALID_RESET_CODE');
    assert.equal(user.password, 'hash');
    assert.equal(revoked, null);
  });

  test('gives an unknown address the same answer as a wrong code', async () => {
    User.findOne = async () => null;

    const res = await call({});

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'INVALID_RESET_CODE');
  });

  test('gives a Google-only account the same answer as a wrong code', async () => {
    user.password = null;

    const res = await call({});

    assert.equal(res.body.code, 'INVALID_RESET_CODE');
  });

  test('rejects a short password before looking at the code', async () => {
    const res = await call({ newPassword: '123' });

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /at least 6/);
    assert.equal(used, false);
  });

  test('rejects malformed keys without spending the code', async () => {
    const res = await call({ publicKey: 'short', encryptedPrivateKey: 'short', keySalt: 'salt' });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'Invalid key format');
    assert.equal(used, false);
    assert.equal(user.password, 'hash');
  });
});
