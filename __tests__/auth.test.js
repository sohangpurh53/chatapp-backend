const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeEmail, emailMatches } = require('../utils/email');
const { User } = require('../models');
const { registerDeviceKey } = require('../controllers/authController');

describe('email matching', () => {
  test('ignores case and surrounding spaces', () => {
    assert.equal(normalizeEmail('  Jamie.Milon@Gmail.COM '), 'jamie.milon@gmail.com');
    assert.equal(normalizeEmail(undefined), '');
    assert.equal(normalizeEmail(42), '');
  });

  test('builds a lower(email) comparison against the normalised address', () => {
    const where = emailMatches('Jamie@Gmail.com');
    assert.equal(where.logic, 'jamie@gmail.com');
    assert.equal(where.attribute.fn, 'lower');
  });
});

describe('registerDeviceKey', () => {
  const publicKey = '-----BEGIN RSA PUBLIC KEY-----\n' + 'A'.repeat(300) + '\n-----END RSA PUBLIC KEY-----';
  const originalFindByPk = User.findByPk;
  let user;

  const call = async (body) => {
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    await registerDeviceKey({ user: { id: 'u1' }, body }, res);
    return res;
  };

  beforeEach(() => {
    user = {
      encryptionEnabled: false,
      publicKey: null,
      update: async function (fields) { Object.assign(this, fields); },
    };
    User.findByPk = async () => user;
  });

  afterEach(() => {
    User.findByPk = originalFindByPk;
  });

  test('stores only the public key for an account without keys', async () => {
    const res = await call({ publicKey });

    assert.equal(res.statusCode, 200);
    assert.equal(user.encryptionEnabled, true);
    assert.equal(user.publicKey, publicKey);
    assert.equal(user.encryptedPrivateKey, undefined);
    assert.deepEqual(res.body.user, { publicKey, encryptionEnabled: true, hasKeyBackup: false });
  });

  test('never replaces keys that already exist', async () => {
    user.encryptionEnabled = true;
    user.publicKey = 'existing';

    const res = await call({ publicKey });

    assert.equal(res.statusCode, 409);
    assert.equal(user.publicKey, 'existing');
  });

  test('rejects a missing, short or oversized key', async () => {
    for (const bad of [undefined, '', 'short', 'x'.repeat(5000), 12345, {}]) {
      const res = await call({ publicKey: bad });
      assert.equal(res.statusCode, 400, `publicKey ${String(bad).slice(0, 10)} should be rejected`);
    }
    assert.equal(user.encryptionEnabled, false);
  });
});
