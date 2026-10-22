const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const express = require('express');

// The controller is exercised through a real Express app with the Sequelize
// models swapped for an in-memory store, so no database is needed.
const sequelize = require('../../config/database');
const { AiProviderConfig, AiUserSettings } = require('../../models');
const ai = require('../../controllers/aiController');

const rows = new Map(); // provider id -> plain object
const settingsRows = new Map(); // userId -> plain object

const wrap = (data, withSecret) => {
  const view = () => {
    const copy = { ...data };
    if (!withSecret) delete copy.encryptedApiKey;
    return copy;
  };
  const instance = {
    get: () => view(),
    async update(values) { Object.assign(data, values, { updatedAt: new Date() }); Object.assign(instance, view()); return instance; },
    async destroy() { rows.delete(data.id); },
  };
  return Object.assign(instance, view());
};

const matches = (data, where) => Object.entries(where).every(([k, v]) => data[k] === v);
const fakeModel = (withSecret) => ({
  findAll: async ({ where }) => [...rows.values()].filter(r => matches(r, where)).map(r => wrap(r, withSecret)),
  findOne: async ({ where }) => {
    const found = [...rows.values()].find(r => matches(r, where));
    return found ? wrap(found, withSecret) : null;
  },
  count: async ({ where }) => [...rows.values()].filter(r => matches(r, where)).length,
});

let server;
let base;
let currentUser = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
const OTHER_USER = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };

before(async () => {
  process.env.AI_CREDENTIALS_KEY = crypto.randomBytes(32).toString('hex');
  Object.assign(AiProviderConfig, fakeModel(false), {
    scope: () => fakeModel(true),
    create: async (values) => {
      const data = { ...values, createdAt: new Date(), updatedAt: new Date() };
      rows.set(data.id, data);
      return wrap(data, true);
    },
  });
  Object.assign(AiUserSettings, {
    findByPk: async (userId) => settingsRows.get(userId) || null,
    upsert: async (values) => { settingsRows.set(values.userId, JSON.parse(JSON.stringify(values))); },
  });
  sequelize.transaction = async (fn) => fn(null);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.get('/config', ai.getConfig);
  app.put('/settings', ai.updateSettings);
  app.post('/providers', ai.createProvider);
  app.put('/providers/:providerId', ai.updateProvider);
  app.delete('/providers/:providerId', ai.deleteProvider);
  app.post('/providers/:providerId/test', ai.testProvider);
  app.get('/providers/:providerId/models', ai.getProviderModels);
  server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());
beforeEach(() => {
  rows.clear();
  settingsRows.clear();
  currentUser = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
});

const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
};

const SECRET = 'sk-live-supersecret-abcdef123456';

describe('AI provider API', () => {
  test('adds a provider, makes it the default and never returns the key', async () => {
    const res = await call('POST', '/providers', { providerType: 'openai', apiKey: SECRET, defaultModel: 'gpt-4.1-mini' });
    assert.equal(res.status, 201);
    assert.ok(!res.text.includes(SECRET));
    assert.ok(!res.text.includes('encryptedApiKey'));
    assert.equal(res.json.provider.hasApiKey, true);
    assert.equal(res.json.provider.apiKeyHint, '••••3456');
    assert.equal(res.json.provider.label, 'OpenAI');
    assert.equal(res.json.provider.deployment, 'cloud');
    assert.equal(res.json.settings.defaultProviderId, res.json.provider.id);

    const stored = rows.get(res.json.provider.id);
    assert.ok(stored.encryptedApiKey && !stored.encryptedApiKey.includes(SECRET));

    const config = await call('GET', '/config');
    assert.ok(!config.text.includes(SECRET));
    assert.ok(!config.text.includes(stored.encryptedApiKey));
    assert.equal(config.json.providers.length, 1);
    assert.equal(config.json.server.credentialStorage, true);
  });

  test('requires a key for providers that need one', async () => {
    const res = await call('POST', '/providers', { providerType: 'groq' });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'MISSING_CREDENTIALS');
  });

  test('Ollama defaults to Ollama Cloud, which needs a key', async () => {
    const missing = await call('POST', '/providers', { providerType: 'ollama' });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, 'MISSING_CREDENTIALS');

    const ok = await call('POST', '/providers', { providerType: 'ollama', apiKey: 'ollama-cloud-key-abcdef12', defaultModel: 'gpt-oss:120b' });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.provider.baseUrl, 'https://ollama.com');
    assert.equal(ok.json.provider.deployment, 'cloud');
    assert.ok(!ok.text.includes('ollama-cloud-key-abcdef12'));

    const cleared = await call('PUT', `/providers/${ok.json.provider.id}`, { clearApiKey: true });
    assert.equal(cleared.status, 400, 'the cloud key cannot be removed while the address is ollama.com');
  });

  test('rejects unknown provider types and dangerous custom endpoints', async () => {
    assert.equal((await call('POST', '/providers', { providerType: 'evil' })).status, 400);
    const ssrf = await call('POST', '/providers', { providerType: 'custom', baseUrl: 'http://169.254.169.254/latest' });
    assert.equal(ssrf.status, 400);
    assert.equal(ssrf.json.code, 'BLOCKED_ENDPOINT');
    const local = await call('POST', '/providers', { providerType: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
    assert.equal(local.json.code, 'BLOCKED_ENDPOINT');
  });

  test('ignores a base URL for fixed-address providers', async () => {
    const res = await call('POST', '/providers', { providerType: 'openai', apiKey: SECRET, baseUrl: 'https://attacker.example.com/v1' });
    assert.equal(res.json.provider.baseUrl, 'https://api.openai.com/v1');
    assert.equal(rows.get(res.json.provider.id).baseUrl, undefined);
  });

  test('refuses to store a key when the server has no encryption key', async () => {
    const saved = process.env.AI_CREDENTIALS_KEY;
    delete process.env.AI_CREDENTIALS_KEY;
    try {
      const res = await call('POST', '/providers', { providerType: 'openai', apiKey: SECRET });
      assert.equal(res.status, 503);
      assert.equal(res.json.code, 'VAULT_NOT_CONFIGURED');
      assert.equal(rows.size, 0);
    } finally {
      process.env.AI_CREDENTIALS_KEY = saved;
    }
  });

  test('editing keeps the key unless a new one is sent, and resets the test status on key change', async () => {
    const { json } = await call('POST', '/providers', { providerType: 'openai', apiKey: SECRET });
    const id = json.provider.id;
    rows.get(id).status = 'ok';
    const before = rows.get(id).encryptedApiKey;

    const renamed = await call('PUT', `/providers/${id}`, { label: 'Work OpenAI', apiKey: '' });
    assert.equal(renamed.json.provider.label, 'Work OpenAI');
    assert.equal(rows.get(id).encryptedApiKey, before);
    assert.equal(renamed.json.provider.status, 'ok');

    const rekeyed = await call('PUT', `/providers/${id}`, { apiKey: 'sk-live-another-key-zzzz9999' });
    assert.notEqual(rows.get(id).encryptedApiKey, before);
    assert.equal(rekeyed.json.provider.apiKeyHint, '••••9999');
    assert.equal(rekeyed.json.provider.status, 'untested');
    assert.ok(!rekeyed.text.includes('sk-live-another-key-zzzz9999'));

    const cleared = await call('PUT', `/providers/${id}`, { clearApiKey: true });
    assert.equal(cleared.status, 400, 'OpenAI cannot run without a key');
  });

  test('users cannot see or touch each other\'s providers', async () => {
    const { json } = await call('POST', '/providers', { providerType: 'openai', apiKey: SECRET });
    const id = json.provider.id;
    currentUser = OTHER_USER;
    assert.equal((await call('PUT', `/providers/${id}`, { label: 'mine now' })).status, 404);
    assert.equal((await call('DELETE', `/providers/${id}`)).status, 404);
    assert.equal((await call('POST', `/providers/${id}/test`)).status, 404);
    assert.equal((await call('GET', `/providers/${id}/models`)).status, 404);
    assert.equal((await call('GET', '/config')).json.providers.length, 0);
    const hijack = await call('PUT', '/settings', { defaultProviderId: id });
    assert.equal(hijack.status, 400);
    assert.equal((await call('PUT', '/providers/not-a-uuid', {})).status, 404);
  });

  test('deleting a provider clears every setting that used it', async () => {
    const first = (await call('POST', '/providers', { providerType: 'openai', apiKey: SECRET })).json.provider.id;
    const second = (await call('POST', '/providers', { providerType: 'gemini', apiKey: 'AIza-something-long' })).json.provider.id;
    await call('PUT', '/settings', { enabled: true, features: { translation: { providerId: second, model: 'gemini-2.5-flash' } } });

    const res = await call('DELETE', `/providers/${second}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.settings.features.translation.providerId, null);
    assert.equal(res.json.settings.defaultProviderId, first, 'the default is untouched');
    assert.equal(rows.has(second), false);
  });

  test('a failed connection test is saved with a readable error', async () => {
    process.env.AI_ALLOW_PRIVATE_ENDPOINTS = 'true';
    const closed = http.createServer();
    await new Promise(r => closed.listen(0, '127.0.0.1', r));
    const port = closed.address().port;
    await new Promise(r => closed.close(r));
    try {
      const { json } = await call('POST', '/providers', { providerType: 'ollama', baseUrl: `http://127.0.0.1:${port}` });
      const res = await call('POST', `/providers/${json.provider.id}/test`, { model: 'llama3.2' });
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, false);
      assert.equal(res.json.error.code, 'UNREACHABLE');
      assert.equal(res.json.provider.status, 'error');
      assert.equal(rows.get(json.provider.id).lastError.code, 'UNREACHABLE');
    } finally {
      delete process.env.AI_ALLOW_PRIVATE_ENDPOINTS;
    }
  });

  test('settings round-trip and validation', async () => {
    const id = (await call('POST', '/providers', { providerType: 'openai', apiKey: SECRET })).json.provider.id;
    const res = await call('PUT', '/settings', { enabled: true, defaultModel: 'gpt-4.1', limits: { dailyRequestLimit: 100 } });
    assert.equal(res.status, 200);
    assert.equal(res.json.settings.defaultProviderId, id);
    assert.equal(res.json.settings.limits.dailyRequestLimit, 100);
    assert.equal((await call('GET', '/config')).json.settings.enabled, true);
    assert.equal((await call('PUT', '/settings', { limits: { dailyRequestLimit: 'lots' } })).status, 400);
  });
});
