const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { User } = require('../models');

// A user row as the beforeUpdate hook sees it
const row = (fields, changed) => ({ ...fields, changed: (name) => changed.includes(name) });

describe('encryptionEnabled follows the public key', () => {
  test('a key kept only on the phone (Google, no password backup) still enables encryption', async () => {
    const user = row({ publicKey: 'PUBLIC', encryptedPrivateKey: null, encryptionEnabled: true }, ['publicKey']);

    await User.runHooks('beforeUpdate', user);

    assert.equal(user.encryptionEnabled, true);
  });

  test('a key with a password backup enables encryption', async () => {
    const user = row({ publicKey: 'PUBLIC', encryptedPrivateKey: 'LOCKED', encryptionEnabled: false }, ['publicKey', 'encryptedPrivateKey']);

    await User.runHooks('beforeUpdate', user);

    assert.equal(user.encryptionEnabled, true);
  });

  test('removing the public key disables encryption', async () => {
    const user = row({ publicKey: null, encryptedPrivateKey: null, encryptionEnabled: true }, ['publicKey']);

    await User.runHooks('beforeUpdate', user);

    assert.equal(user.encryptionEnabled, false);
  });
});

describe('GET /users/:userId/public-key', () => {
  const { getUserPublicKey } = require('../controllers/authController');

  const call = async (found) => {
    const original = User.findByPk;
    User.findByPk = async () => found;
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    try {
      await getUserPublicKey({ params: { userId: 'u1' } }, res);
    } finally {
      User.findByPk = original;
    }
    return res;
  };

  test('hands out a public key even if the account was wrongly flagged as not encrypted', async () => {
    const res = await call({ id: 'u1', username: 'dev', publicKey: 'PUBLIC', encryptionEnabled: false });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.publicKey, 'PUBLIC');
  });

  test('says encryption is off when the account has no public key', async () => {
    const res = await call({ id: 'u1', username: 'dev', publicKey: null, encryptionEnabled: false });

    assert.equal(res.statusCode, 404);
    assert.match(res.body.error, /not have encryption enabled/);
  });
});
