const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const express = require('express');

const memory = require('../../services/ai/memory');
const vault = require('../../services/ai/credentialVault');
const { AiProviderConfig, AiUserSettings, AiUsageEvent, ChatParticipant, Chat } = require('../../models');
const { ask } = require('../../controllers/aiAssistController');

const CHAT = '99999999-9999-4999-8999-999999999999';
const evidence = [
  { ref: 'm1', speaker: 1, text: 'How about Hotel Aurora or the Lakeview?', at: '2026-10-20T10:00:00Z' },
  { ref: 'm2', fromMe: true, text: 'Lakeview looks better, 120 a night', at: '2026-10-20T10:05:00Z' },
  { ref: 'm3', speaker: 2, text: 'Agreed, Lakeview it is. I will book the tickets', at: '2026-10-20T10:07:00Z' },
  { ref: 'm4', speaker: 1, text: 'What time do we leave?', at: '2026-10-20T10:09:00Z' },
];

describe('memory request validation', () => {
  test('accepts a question with evidence and pseudonymises speakers', () => {
    const input = memory.parseRequest({ chatId: CHAT, question: 'Which hotel did we pick?', evidence });
    assert.equal(input.mode, 'ask');
    assert.deepEqual(input.evidence.map(e => e.speaker), ['Person 1', 'Me', 'Person 2', 'Person 1']);
  });

  test('rejects bad input', () => {
    const bad = (body) => assert.throws(() => memory.parseRequest(body), { code: 'VALIDATION_ERROR' });
    bad({ question: 'x', evidence });
    bad({ chatId: CHAT, question: '', evidence });
    bad({ chatId: CHAT, question: 'x'.repeat(501), evidence });
    bad({ chatId: CHAT, question: 'x', evidence: [] });
    bad({ chatId: CHAT, question: 'x', evidence: [{ ref: 'bad', text: 'x' }] });
    bad({ chatId: CHAT, question: 'x', evidence: [{ ref: 'm1', text: 'x' }, { ref: 'm1', text: 'y' }] });
    bad({ chatId: CHAT, question: 'x', evidence: Array.from({ length: 121 }, (_, i) => ({ ref: `m${i}`, text: 'x' })) });
    bad({ chatId: CHAT, question: 'x', evidence: Array.from({ length: 20 }, (_, i) => ({ ref: `m${i}`, text: 'y'.repeat(1000) })) });
  });

  test('summary mode needs no question', () => {
    assert.equal(memory.parseRequest({ chatId: CHAT, mode: 'summary', evidence }).mode, 'summary');
  });
});

describe('memory prompt', () => {
  test('separates decisions from suggestions and keeps the model to the evidence', () => {
    const [system, user] = memory.buildMessages(memory.parseRequest({ chatId: CHAT, question: 'Which hotel?', evidence }));
    assert.match(system.content, /One person proposing something is a "suggestion", not a decision/);
    assert.match(system.content, /"insufficient"/);
    assert.match(system.content, /Never invent names/);
    assert.match(system.content, /relative to when the message was sent/);
    assert.match(user.content, /\[m3\] 2026-10-20 10:07 UTC Person 2: Agreed, Lakeview it is/);
  });
});

describe('memory answers', () => {
  const input = memory.parseRequest({ chatId: CHAT, question: 'Which hotel?', evidence });

  test('keeps cited points and drops invented citations', () => {
    const out = memory.parseAnswer(JSON.stringify({
      status: 'answered',
      answer: 'You agreed on the Lakeview.',
      points: [
        { type: 'decision', text: 'Lakeview chosen', refs: ['m2', 'm3', 'm99'] },
        { type: 'suggestion', text: 'Hotel Aurora was suggested', refs: ['m1'] },
        { type: 'info', text: 'Made up point', refs: ['m42'] },
        { type: 'weird', text: 'Person 2 books tickets', refs: ['m3'] },
      ],
    }), input);
    assert.equal(out.points.length, 3);
    assert.deepEqual(out.points[0].refs, ['m2', 'm3']);
    assert.equal(out.points[2].type, 'info');
    assert.equal(out.droppedRefs, 2);
    assert.equal(out.unsupported, false);
  });

  test('an answer without any real citation is flagged', () => {
    const out = memory.parseAnswer('{"status":"answered","answer":"The Ritz.","points":[{"type":"decision","text":"Ritz","refs":["m77"]}]}', input);
    assert.equal(out.unsupported, true);
    assert.equal(out.points.length, 0);
  });

  test('insufficient evidence is passed through with a default explanation', () => {
    const out = memory.parseAnswer('{"status":"insufficient","answer":"","points":[]}', input);
    assert.equal(out.status, 'insufficient');
    assert.match(out.answer, /do not contain enough/);
    assert.equal(out.unsupported, false);
  });

  test('plain text from a model without JSON is shown but not marked as sourced', () => {
    const out = memory.parseAnswer('The Lakeview, I think.', input);
    assert.equal(out.unsupported, true);
    assert.equal(out.answer, 'The Lakeview, I think.');
  });

  test('empty answers are errors', () => {
    assert.throws(() => memory.parseAnswer('  ', input), { code: 'BAD_RESPONSE' });
  });
});

describe('POST /ai/memory', () => {
  const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const PROVIDER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  let providerServer;
  let server;
  let base;
  let seen = [];
  let content = '';
  let members;
  let settingsRow;

  before(async () => {
    process.env.AI_CREDENTIALS_KEY = crypto.randomBytes(32).toString('hex');
    process.env.AI_ALLOW_PRIVATE_ENDPOINTS = 'true';
    providerServer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        seen.push(JSON.parse(raw));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 300, completion_tokens: 60 } }));
      });
    });
    await new Promise(r => providerServer.listen(0, '127.0.0.1', r));
    const providerRow = () => ({
      id: PROVIDER, userId: USER, providerType: 'custom', label: 'Test LLM', enabled: true,
      baseUrl: `http://127.0.0.1:${providerServer.address().port}/v1`, defaultModel: 'base-model',
      capabilityOverrides: { structuredOutput: true },
      encryptedApiKey: vault.encrypt('sk-test-key-1234567', { userId: USER, providerId: PROVIDER }),
    });
    AiUserSettings.findByPk = async () => settingsRow;
    AiProviderConfig.scope = () => ({ findAll: async () => [{ get: providerRow }] });
    AiUsageEvent.count = async () => 0;
    AiUsageEvent.findOne = async () => ({ input: 0, output: 0, requests: 0 });
    AiUsageEvent.create = async (v) => v;
    // Not a group: the group AI policy doesn't apply
    Chat.findByPk = async (id) => ({ id, isGroup: false, settings: {} });
    ChatParticipant.findOne = async ({ where }) => (members.has(where.chatId) && where.userId === USER ? { id: 'm' } : null);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: USER }; next(); });
    app.post('/memory', ask);
    server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server.close();
    providerServer.close();
    delete process.env.AI_ALLOW_PRIVATE_ENDPOINTS;
  });

  beforeEach(() => {
    seen = [];
    members = new Set([CHAT]);
    settingsRow = { enabled: true, defaultProviderId: PROVIDER, features: { memory: { enabled: true, providerId: PROVIDER, model: 'memory-model' } }, limits: {} };
    content = JSON.stringify({ status: 'answered', answer: 'Lakeview.', points: [{ type: 'decision', text: 'Lakeview chosen', refs: ['m3'] }] });
  });

  const post = async (body) => {
    const res = await fetch(`${base}/memory`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };

  test('answers with citations using the memory feature model', async () => {
    const res = await post({ chatId: CHAT, question: 'Which hotel?', evidence });
    assert.equal(res.status, 200);
    assert.equal(res.json.points[0].type, 'decision');
    assert.deepEqual(res.json.points[0].refs, ['m3']);
    assert.equal(res.json.searched, 4);
    assert.equal(seen[0].model, 'memory-model');
    assert.deepEqual(seen[0].response_format, { type: 'json_object' });
  });

  test('non-members get nothing and nothing is sent', async () => {
    members = new Set();
    const res = await post({ chatId: CHAT, question: 'Which hotel?', evidence });
    assert.equal(res.status, 403);
    assert.equal(seen.length, 0);
  });

  test('turning the memory feature off stops it', async () => {
    settingsRow.features.memory.enabled = false;
    const res = await post({ chatId: CHAT, question: 'Which hotel?', evidence });
    assert.equal(res.json.code, 'FEATURE_DISABLED');
    assert.equal(seen.length, 0);
  });
});
