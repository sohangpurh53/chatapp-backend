const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { requireAdmin } = require('../middleware/adminAuth');

describe('admin login', () => {
  const original = { user: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD };
  const basic = (value) => `Basic ${Buffer.from(value).toString('base64')}`;

  const attempt = (authorization) => {
    const result = { passed: false, status: null, headers: {} };
    requireAdmin(
      { headers: authorization ? { authorization } : {} },
      {
        setHeader: (name, value) => { result.headers[name] = value; },
        status(code) { result.status = code; return this; },
        json() { return this; },
      },
      () => { result.passed = true; },
    );
    return result;
  };

  beforeEach(() => {
    process.env.ADMIN_USER = 'admin';
    process.env.ADMIN_PASSWORD = 'pass:word';
  });

  afterEach(() => {
    for (const [name, value] of [['ADMIN_USER', original.user], ['ADMIN_PASSWORD', original.password]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test('the right login gets in, even with a colon in the password', () => {
    assert.equal(attempt(basic('admin:pass:word')).passed, true);
  });

  test('no login asks the browser for one', () => {
    const result = attempt();
    assert.equal(result.status, 401);
    assert.match(result.headers['WWW-Authenticate'], /^Basic/);
  });

  test('a wrong password is refused', () => {
    assert.equal(attempt(basic('admin:nope')).passed, false);
  });

  test('nobody gets in when no password is configured', () => {
    delete process.env.ADMIN_PASSWORD;
    assert.equal(attempt(basic('admin:')).passed, false);
    assert.equal(attempt(basic('admin:undefined')).passed, false);
  });
});
