const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const vault = require('../../services/ai/credentialVault');
const { classifyAddress, validateBaseUrl, guardedLookup } = require('../../services/ai/urlGuard');
const { redact, fromProviderResponse, AiError } = require('../../services/ai/errors');

const KEY_A = crypto.randomBytes(32).toString('hex');
const KEY_B = crypto.randomBytes(32).toString('base64');
const ctx = { userId: 'u1', providerId: 'p1' };

describe('credential vault', () => {
  beforeEach(() => {
    process.env.AI_CREDENTIALS_KEY = KEY_A;
    delete process.env.AI_CREDENTIALS_KEY_PREVIOUS;
  });

  test('round-trips a secret and never stores it in clear', () => {
    const blob = vault.encrypt('sk-test-1234567890abcdef', ctx);
    assert.ok(!blob.includes('sk-test'));
    assert.equal(vault.decrypt(blob, ctx).plaintext, 'sk-test-1234567890abcdef');
  });

  test('ciphertext is bound to its user and provider row', () => {
    const blob = vault.encrypt('secret-value-123', ctx);
    assert.throws(() => vault.decrypt(blob, { userId: 'u2', providerId: 'p1' }), { code: 'VAULT_DECRYPT_FAILED' });
    assert.throws(() => vault.decrypt(blob, { userId: 'u1', providerId: 'p2' }), { code: 'VAULT_DECRYPT_FAILED' });
  });

  test('rejects tampered ciphertext', () => {
    const parsed = JSON.parse(vault.encrypt('secret-value-123', ctx));
    const ct = Buffer.from(parsed.ct, 'base64');
    ct[0] ^= 1;
    parsed.ct = ct.toString('base64');
    assert.throws(() => vault.decrypt(JSON.stringify(parsed), ctx), { code: 'VAULT_DECRYPT_FAILED' });
  });

  test('decrypts with a previous key after rotation and flags it', () => {
    const blob = vault.encrypt('secret-value-123', ctx);
    process.env.AI_CREDENTIALS_KEY = KEY_B;
    process.env.AI_CREDENTIALS_KEY_PREVIOUS = KEY_A;
    const result = vault.decrypt(blob, ctx);
    assert.equal(result.plaintext, 'secret-value-123');
    assert.equal(result.needsRotation, true);
    assert.equal(vault.decrypt(vault.encrypt('x-secret-1', ctx), ctx).needsRotation, false);
  });

  test('refuses to store keys without AI_CREDENTIALS_KEY', () => {
    delete process.env.AI_CREDENTIALS_KEY;
    assert.equal(vault.isConfigured(), false);
    assert.throws(() => vault.encrypt('secret', ctx), { code: 'VAULT_NOT_CONFIGURED' });
  });

  test('a malformed key counts as not configured', () => {
    process.env.AI_CREDENTIALS_KEY = 'too-short';
    assert.equal(vault.isConfigured(), false);
    assert.throws(() => vault.encrypt('secret', ctx), { code: 'VAULT_NOT_CONFIGURED' });
  });

  test('hints show only the last four characters', () => {
    assert.equal(vault.hintFor('sk-abcdefghijklmnop'), '••••mnop');
    assert.equal(vault.hintFor('short'), '••••');
  });
});

describe('endpoint guard (SSRF)', () => {
  test('classifies addresses', () => {
    assert.equal(classifyAddress('8.8.8.8'), 'public');
    assert.equal(classifyAddress('127.0.0.1'), 'private');
    assert.equal(classifyAddress('10.1.2.3'), 'private');
    assert.equal(classifyAddress('172.20.0.1'), 'private');
    assert.equal(classifyAddress('172.32.0.1'), 'public');
    assert.equal(classifyAddress('192.168.1.10'), 'private');
    assert.equal(classifyAddress('100.64.0.1'), 'private');
    assert.equal(classifyAddress('169.254.169.254'), 'blocked');
    assert.equal(classifyAddress('0.0.0.0'), 'blocked');
    assert.equal(classifyAddress('224.0.0.1'), 'blocked');
    assert.equal(classifyAddress('::1'), 'private');
    assert.equal(classifyAddress('::'), 'blocked');
    assert.equal(classifyAddress('fe80::1'), 'blocked');
    assert.equal(classifyAddress('fd00::1'), 'private');
    assert.equal(classifyAddress('::ffff:169.254.169.254'), 'blocked');
    assert.equal(classifyAddress('::ffff:127.0.0.1'), 'private');
    assert.equal(classifyAddress('64:ff9b::a9fe:a9fe'), 'blocked');
    assert.equal(classifyAddress('2606:4700::1111'), 'public');
  });

  test('accepts normal https endpoints and strips the trailing slash', () => {
    assert.equal(validateBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
    assert.equal(validateBaseUrl('https://8.8.8.8:8443/v1'), 'https://8.8.8.8:8443/v1');
  });

  test('rejects malformed and dangerous endpoints', () => {
    const rejects = (url, code, opts) => assert.throws(() => validateBaseUrl(url, opts), { code });
    rejects('not a url', 'INVALID_ENDPOINT');
    rejects('ftp://example.com', 'INVALID_ENDPOINT');
    rejects('file:///etc/passwd', 'INVALID_ENDPOINT');
    rejects('https://user:pass@example.com', 'INVALID_ENDPOINT');
    rejects('https://example.com/v1?redirect=x', 'INVALID_ENDPOINT');
    rejects('http://example.com/v1', 'INSECURE_ENDPOINT');
    rejects('http://169.254.169.254/latest/meta-data', 'BLOCKED_ENDPOINT', { allowPrivate: true });
    rejects('https://[fe80::1]/', 'BLOCKED_ENDPOINT', { allowPrivate: true });
    rejects('http://127.0.0.1:11434', 'BLOCKED_ENDPOINT');
    rejects('http://localhost:11434', 'BLOCKED_ENDPOINT');
    rejects('http://192.168.1.5:11434', 'BLOCKED_ENDPOINT');
    rejects('https://metadata.google.internal/', 'BLOCKED_ENDPOINT', { allowPrivate: true });
    rejects('http://8.8.8.8/v1', 'INSECURE_ENDPOINT', { allowPrivate: true });
  });

  test('private endpoints work only when the operator allows them', () => {
    assert.equal(validateBaseUrl('http://localhost:11434', { allowPrivate: true }), 'http://localhost:11434');
    assert.equal(validateBaseUrl('http://192.168.1.5:11434/', { allowPrivate: true }), 'http://192.168.1.5:11434');
  });

  test('connect-time lookup refuses names that resolve to private addresses', async () => {
    const lookup = guardedLookup({ allowPrivate: false, protocol: 'https:' });
    const error = await new Promise(resolve => lookup('localhost', {}, (err) => resolve(err)));
    assert.equal(error.code, 'BLOCKED_ENDPOINT');
    const allowed = guardedLookup({ allowPrivate: true, protocol: 'http:' });
    const address = await new Promise((resolve, reject) => allowed('localhost', {}, (err, addr) => (err ? reject(err) : resolve(addr))));
    assert.ok(address === '127.0.0.1' || address === '::1');
  });
});

describe('error mapping and redaction', () => {
  test('redacts key shapes and exact secrets', () => {
    const text = 'Incorrect API key provided: sk-proj-abcdefghijklmnop. Bearer abc.def.ghijklmnop key=AIzaSyA1234567890123456789012345 my-own-secret';
    const out = redact(text, ['my-own-secret']);
    assert.ok(!out.includes('sk-proj-abcdefghijklmnop'));
    assert.ok(!out.includes('abc.def.ghijklmnop'));
    assert.ok(!out.includes('AIzaSy'));
    assert.ok(!out.includes('my-own-secret'));
  });

  test('maps provider statuses to clear codes', () => {
    assert.equal(fromProviderResponse(401, '{"error":{"message":"bad"}}').code, 'INVALID_CREDENTIALS');
    assert.equal(fromProviderResponse(400, '{"error":{"message":"API key not valid. Please pass a valid API key."}}').code, 'INVALID_CREDENTIALS');
    assert.equal(fromProviderResponse(403, '{}').code, 'PERMISSION_DENIED');
    assert.equal(fromProviderResponse(404, '{}', { model: 'x' }).code, 'MODEL_NOT_FOUND');
    assert.equal(fromProviderResponse(404, 'Not Found').code, 'ENDPOINT_NOT_FOUND');
    assert.equal(fromProviderResponse(429, '{"error":{"message":"slow down"}}').code, 'RATE_LIMITED');
    assert.equal(fromProviderResponse(429, '{"error":{"message":"You exceeded your current quota"}}').code, 'QUOTA_EXCEEDED');
    assert.equal(fromProviderResponse(503, '').code, 'PROVIDER_UNAVAILABLE');
    assert.equal(fromProviderResponse(400, '{"error":{"message":"The model `x` does not exist"}}').code, 'MODEL_NOT_FOUND');
  });

  test('provider detail never carries the key', () => {
    const error = fromProviderResponse(401, '{"error":{"message":"Incorrect API key provided: gsk_abcdefghijkl1234"}}', { secrets: ['gsk_abcdefghijkl1234'] });
    assert.ok(error instanceof AiError);
    assert.ok(!JSON.stringify(error.toJSON()).includes('gsk_abcdefghijkl1234'));
  });
});
