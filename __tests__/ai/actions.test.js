const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const express = require('express');

const actions = require('../../services/ai/actions');
const vault = require('../../services/ai/credentialVault');
const { AiProviderConfig, AiUserSettings, AiUsageEvent, ChatParticipant, Chat } = require('../../models');
const { findActions } = require('../../controllers/aiAssistController');

const CHAT = '99999999-9999-4999-8999-999999999999';
const evidence = [
  { ref: 'm1', speaker: 1, text: 'Hotel Aurora or the Lakeview?', at: '2026-10-20T10:00:00Z' },
  { ref: 'm2', fromMe: true, text: 'Lakeview looks better', at: '2026-10-20T10:05:00Z' },
  { ref: 'm3', speaker: 2, text: 'Agreed. I will book the tickets by Friday', at: '2026-10-20T10:07:00Z' },
  { ref: 'm4', speaker: 1, text: 'Can you send the itinerary tomorrow at 5?', at: '2026-10-20T10:09:00Z' },
];
const input = actions.parseRequest({ chatId: CHAT, evidence, utcOffsetMinutes: 330 });
const parse = (cards) => actions.parseCards(JSON.stringify({ cards }), input);

describe('action card checks', () => {
  test('keeps a grounded task with owner and stated deadline', () => {
    const { cards } = parse([{ type: 'task', title: 'Book the tickets', owner: 'Person 2', ownerRefs: ['m3'], dueText: 'by Friday', dueDate: '2026-10-24', dueTime: null, refs: ['m3'] }]);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].owner, 'Person 2');
    assert.equal(cards[0].ownerBasis, 'volunteered');
    assert.deepEqual(cards[0].due, { text: 'by Friday', date: '2026-10-24', time: null });
    assert.equal(cards[0].status, 'proposed');
  });

  test('an owner asked by someone else is kept but marked as mentioned', () => {
    const { cards } = parse([{ type: 'task', title: 'Send the itinerary', owner: 'Me', ownerRefs: ['m4'], dueText: 'tomorrow at 5', dueDate: '2026-10-21', dueTime: '17:00', refs: ['m4'] }]);
    assert.equal(cards[0].owner, 'Me');
    assert.equal(cards[0].ownerBasis, 'mentioned');
    assert.equal(cards[0].due.time, '17:00');
  });

  test('drops deadlines that no message states, and impossible dates', () => {
    const { cards, checks } = parse([
      { type: 'task', title: 'Book the tickets', dueText: 'by Monday', dueDate: '2026-10-27', refs: ['m3'] },
      { type: 'task', title: 'Book again', dueText: 'by Friday', dueDate: '2026-02-30', refs: ['m3'] },
    ]);
    assert.equal(cards[0].due, null);
    assert.equal(cards[1].due, null);
    assert.equal(checks.droppedDates, 2);
  });

  test('drops owners without evidence and people who are not in the chat', () => {
    const { cards, checks } = parse([
      { type: 'task', title: 'A', owner: 'Person 2', ownerRefs: [], refs: ['m3'] },
      { type: 'task', title: 'B', owner: 'Person 9', ownerRefs: ['m3'], refs: ['m3'] },
      { type: 'task', title: 'C', owner: 'Alice', ownerRefs: ['m3'], refs: ['m3'] },
    ]);
    assert.deepEqual(cards.map(c => c.owner), [null, null, null]);
    assert.equal(checks.droppedOwners, 2);
  });

  test('drops cards without real sources, unknown types and polls without options', () => {
    const { cards, checks } = parse([
      { type: 'task', title: 'Invented', refs: ['m42'] },
      { type: 'launch', title: 'Rocket', refs: ['m1'] },
      { type: 'poll', title: 'Which hotel?', options: ['Aurora'], refs: ['m1'] },
      { type: 'poll', title: 'Which hotel?', options: ['Aurora', 'Lakeview', 'Aurora'], refs: ['m1', 'm2'] },
    ]);
    assert.equal(cards.length, 1);
    assert.deepEqual(cards[0].options, ['Aurora', 'Lakeview']);
    assert.equal(checks.droppedCards, 3);
  });

  test('rejects answers that are not JSON', () => {
    assert.throws(() => actions.parseCards('sure, here are some tasks', input), { code: 'BAD_RESPONSE' });
  });

  test('the prompt shows local times with weekdays and forbids invented details', () => {
    const [system, user] = actions.buildMessages(input);
    assert.match(system.content, /Never invent tasks, people, dates/);
    assert.match(system.content, /Only when agreement is explicit/);
    assert.match(user.content, /\[m3\] Tue 2026-10-20 15:37 Person 2: Agreed\. I will book the tickets by Friday/);
  });

  test('real date check', () => {
    assert.equal(actions.isRealDate('2026-10-24'), true);
    assert.equal(actions.isRealDate('2026-13-01'), false);
    assert.equal(actions.isRealDate('Friday'), false);
  });
});

describe('POST /ai/actions', () => {
  const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const PROVIDER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  let providerServer;
  let server;
  let base;
  let seen = [];
  let members;
  let settingsRow;
  const content = JSON.stringify({ cards: [{ type: 'task', title: 'Book the tickets', owner: 'Person 2', ownerRefs: ['m3'], dueText: 'by Friday', dueDate: '2026-10-24', refs: ['m3'] }] });

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
    app.post('/actions', findActions);
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
    settingsRow = { enabled: true, defaultProviderId: PROVIDER, features: { actions: { enabled: true, providerId: PROVIDER, model: 'actions-model' } }, limits: {} };
  });

  const post = async (body) => {
    const res = await fetch(`${base}/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };

  test('returns checked proposals from the actions feature model', async () => {
    const res = await post({ chatId: CHAT, evidence });
    assert.equal(res.status, 200);
    assert.equal(res.json.cards[0].status, 'proposed');
    assert.equal(res.json.cards[0].due.date, '2026-10-24');
    assert.equal(seen[0].model, 'actions-model');
  });

  test('non-members are refused before anything is sent', async () => {
    members = new Set();
    const res = await post({ chatId: CHAT, evidence });
    assert.equal(res.status, 403);
    assert.equal(seen.length, 0);
  });

  test('the actions feature can be turned off', async () => {
    settingsRow.features.actions.enabled = false;
    const res = await post({ chatId: CHAT, evidence });
    assert.equal(res.json.code, 'FEATURE_DISABLED');
    assert.equal(seen.length, 0);
  });
});
