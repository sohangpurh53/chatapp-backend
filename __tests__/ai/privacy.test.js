const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const express = require('express');

const privacy = require('../../services/ai/privacy');
const settings = require('../../services/ai/settings');
const runner = require('../../services/ai/runner');
const vault = require('../../services/ai/credentialVault');
const { AiProviderConfig, AiUserSettings, AiUsageEvent, ChatParticipant, Chat } = require('../../models');
const assistCtl = require('../../controllers/aiAssistController');
const aiCtl = require('../../controllers/aiController');
const registry = require('../../services/ai/registry');

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLOUD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CHAT = '99999999-9999-4999-8999-999999999999';
const GROUP = '88888888-8888-4888-8888-888888888888';

describe('consent rules', () => {
  const groq = { id: CLOUD, providerType: 'groq', label: 'Groq' };
  const local = { id: 'p-local', providerType: 'ollama', label: 'Home', baseUrl: 'http://10.0.0.5:11434' };

  test('cloud providers need consent per kind of text; self-hosted ones do not', () => {
    const s = settings.defaultSettings();
    assert.throws(() => privacy.requireConsent(s, groq, 'drafts'), (e) => e.code === 'CONSENT_REQUIRED' && e.data.scope === 'drafts' && e.data.providerLabel === 'Groq');
    assert.doesNotThrow(() => privacy.requireConsent(s, local, 'conversation'));

    const granted = privacy.grant(s, groq, 'drafts');
    assert.doesNotThrow(() => privacy.requireConsent(granted, groq, 'drafts'));
    assert.throws(() => privacy.requireConsent(granted, groq, 'conversation'), { code: 'CONSENT_REQUIRED' });
  });

  test('consent is tied to the provider address and policy version', () => {
    const ollamaCloud = { id: 'p2', providerType: 'ollama', label: 'Ollama', baseUrl: 'https://ollama.com' };
    const granted = privacy.grant(settings.defaultSettings(), ollamaCloud, 'conversation');
    assert.doesNotThrow(() => privacy.requireConsent(granted, ollamaCloud, 'conversation'));
    const moved = { ...ollamaCloud, baseUrl: 'https://eu.ollama.com' };
    assert.throws(() => privacy.requireConsent(granted, moved, 'conversation'), { code: 'CONSENT_REQUIRED' });
    granted.consents.p2.conversation.version = 0;
    assert.throws(() => privacy.requireConsent(granted, ollamaCloud, 'conversation'), { code: 'CONSENT_REQUIRED' });
  });

  test('revoking one scope, one provider or everything', () => {
    let s = privacy.grant(privacy.grant(settings.defaultSettings(), groq, 'drafts'), groq, 'conversation');
    s = privacy.revoke(s, CLOUD, 'drafts');
    assert.deepEqual(Object.keys(s.consents[CLOUD]), ['conversation']);
    assert.deepEqual(privacy.revoke(s, CLOUD, null).consents, {});
    assert.deepEqual(privacy.revoke(s, null, null).consents, {});
  });

  test('settings: context level is validated, consents only change through the consent endpoints, deleting a provider forgets its consent', () => {
    const base = settings.defaultSettings();
    assert.equal(base.contextLevel, 'standard');
    assert.equal(settings.applyUpdate(base, { contextLevel: 'minimal' }, new Set()).contextLevel, 'minimal');
    assert.throws(() => settings.applyUpdate(base, { contextLevel: 'everything' }, new Set()), { code: 'VALIDATION_ERROR' });
    assert.throws(() => settings.applyUpdate(base, { consents: {} }, new Set()), { code: 'VALIDATION_ERROR' });
    const granted = privacy.grant(base, groq, 'drafts');
    assert.deepEqual(settings.withoutProvider(granted, CLOUD).consents, {});
  });

  test('context caps', () => {
    const s = (level) => ({ ...settings.defaultSettings(), contextLevel: level });
    assert.equal(privacy.conversationCap(s('standard'), 'evidence'), 120);
    assert.equal(privacy.conversationCap(s('minimal'), 'replyMessages'), 5);
    assert.throws(() => privacy.conversationCap(s('off'), 'evidence'), { code: 'CONTEXT_DISABLED' });
  });
});

describe('cost estimate', () => {
  test('uses only prices the user entered and warns at the limit', async () => {
    const saved = AiUsageEvent.findAll;
    AiUsageEvent.findAll = async () => [
      { providerId: 'a', input: 600000, output: 400000 },
      { providerId: 'b', input: 1000, output: 0 },
    ];
    try {
      const est = await runner.costEstimate(USER, [{ id: 'a', pricePerMillionTokensUsd: 2 }, { id: 'b' }], { monthlyCostWarningUsd: 1.5 });
      assert.equal(est.estimatedCostUsd, 2);
      assert.equal(est.costComplete, false);
      assert.equal(est.costWarning, true);
      const none = await runner.costEstimate(USER, [{ id: 'a' }], {});
      assert.equal(none.estimatedCostUsd, null);
    } finally {
      AiUsageEvent.findAll = saved;
    }
  });
});

describe('enforcement on the endpoints', () => {
  let providerServer;
  let server;
  let base;
  let seen = [];
  let settingsRow;
  let providerRow;
  let groupSettings;

  const realDeploymentOf = registry.deploymentOf;

  before(async () => {
    process.env.AI_CREDENTIALS_KEY = crypto.randomBytes(32).toString('hex');
    // The fake provider runs on localhost (always self-hosted); treat it as a cloud service here
    registry.deploymentOf = (p) => (p.id === CLOUD ? 'cloud' : realDeploymentOf(p));
    providerServer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        seen.push(JSON.parse(raw || '{}'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '{"drafts":["ok"],"status":"answered","answer":"ok","points":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      });
    });
    await new Promise(r => providerServer.listen(0, '127.0.0.1', r));

    AiUserSettings.findByPk = async () => settingsRow;
    AiUserSettings.upsert = async (values) => { settingsRow = JSON.parse(JSON.stringify(values)); };
    AiProviderConfig.scope = () => ({ findAll: async () => [{ get: () => providerRow }] });
    AiProviderConfig.findOne = async ({ where }) => (where.id === providerRow.id && where.userId === USER ? { get: () => providerRow } : null);
    AiUsageEvent.count = async () => 0;
    AiUsageEvent.findOne = async () => ({ input: 0, output: 0, requests: 0 });
    AiUsageEvent.create = async (v) => v;
    ChatParticipant.findOne = async ({ where }) => (where.userId === USER ? { id: 'm' } : null);
    Chat.findByPk = async (id) => (id === GROUP ? { id, isGroup: true, settings: groupSettings } : { id, isGroup: false, settings: {} });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: USER }; next(); });
    app.post('/assist', assistCtl.assist);
    app.post('/memory', assistCtl.ask);
    app.post('/consent', aiCtl.grantConsent);
    app.post('/consent/revoke', aiCtl.revokeConsent);
    server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    registry.deploymentOf = realDeploymentOf;
    server.close();
    providerServer.close();
  });

  beforeEach(() => {
    seen = [];
    groupSettings = {};
    // A cloud provider (custom endpoint declared as cloud) on a test server
    process.env.AI_ALLOW_PRIVATE_ENDPOINTS = 'true';
    providerRow = {
      id: CLOUD, userId: USER, providerType: 'custom', label: 'Cloud LLM', enabled: true, deploymentType: 'cloud',
      baseUrl: `http://localhost:${providerServer.address().port}/v1`, defaultModel: 'm',
      capabilityOverrides: { structuredOutput: true },
      encryptedApiKey: vault.encrypt('sk-test-key-1234567', { userId: USER, providerId: CLOUD }),
    };
    settingsRow = { enabled: true, defaultProviderId: CLOUD, features: {}, limits: {}, contextLevel: 'standard', consents: {} };
  });

  const post = async (path, body) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  const evidence = Array.from({ length: 30 }, (_, i) => ({ ref: `m${i + 1}`, speaker: 1, text: `message ${i + 1}`, at: '2026-10-20T10:00:00Z' }));

  test('nothing reaches a cloud provider before consent; consent for drafts does not cover conversations', async () => {
    const blocked = await post('/assist', { action: 'shorter', text: 'hello there' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.code, 'CONSENT_REQUIRED');
    assert.deepEqual(blocked.json.data, { providerId: CLOUD, providerLabel: 'Cloud LLM', providerType: 'custom', scope: 'drafts' });
    assert.equal(seen.length, 0);

    assert.equal((await post('/consent', { providerId: CLOUD, scope: 'drafts' })).status, 200);
    assert.equal((await post('/assist', { action: 'shorter', text: 'hello there' })).status, 200);
    assert.equal(seen.length, 1);

    const memory = await post('/memory', { chatId: CHAT, question: 'what?', evidence });
    assert.equal(memory.json.code, 'CONSENT_REQUIRED');
    assert.equal(memory.json.data.scope, 'conversation');
    assert.equal(seen.length, 1);
  });

  test('revoking consent stops sending again', async () => {
    await post('/consent', { providerId: CLOUD, scope: 'drafts' });
    await post('/consent/revoke', { providerId: CLOUD, scope: 'drafts' });
    assert.equal((await post('/assist', { action: 'shorter', text: 'hello' })).json.code, 'CONSENT_REQUIRED');
    assert.equal(seen.length, 0);
  });

  test('consent can only be given for your own providers', async () => {
    const res = await post('/consent', { providerId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', scope: 'drafts' });
    assert.equal(res.status, 404);
    assert.equal((await post('/consent', { providerId: CLOUD, scope: 'everything' })).status, 400);
  });

  test('the context level caps how many messages are sent, and off sends none', async () => {
    await post('/consent', { providerId: CLOUD, scope: 'conversation' });
    settingsRow.contextLevel = 'minimal';
    const res = await post('/memory', { chatId: CHAT, question: 'what?', evidence });
    assert.equal(res.status, 200);
    assert.equal(res.json.searched, 20);
    const sent = seen[0].messages[1].content;
    assert.ok(sent.includes('message 30') && !sent.includes('message 10:'), 'keeps the newest 20');

    settingsRow.contextLevel = 'off';
    seen = [];
    assert.equal((await post('/memory', { chatId: CHAT, question: 'what?', evidence })).json.code, 'CONTEXT_DISABLED');
    assert.equal((await post('/assist', { action: 'reply', chatId: CHAT, context: [{ speaker: 1, text: 'hi' }] })).json.code, 'CONTEXT_DISABLED');
    assert.equal(seen.length, 0);
  });

  test("a group's admins can turn AI off for the group's messages, but members' own drafts still work", async () => {
    await post('/consent', { providerId: CLOUD, scope: 'conversation' });
    await post('/consent', { providerId: CLOUD, scope: 'drafts' });
    groupSettings = { allowAiOnMessages: false };
    const res = await post('/memory', { chatId: GROUP, question: 'what?', evidence });
    assert.equal(res.status, 403);
    assert.equal(res.json.code, 'GROUP_AI_DISABLED');
    assert.equal((await post('/assist', { action: 'reply', chatId: GROUP, context: [{ speaker: 1, text: 'hi' }] })).json.code, 'GROUP_AI_DISABLED');
    assert.equal(seen.length, 0);
    assert.equal((await post('/assist', { action: 'shorter', chatId: GROUP, text: 'my own draft' })).status, 200);
  });
});
