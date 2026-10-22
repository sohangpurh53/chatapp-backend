const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');

const openai = require('../../services/ai/adapters/openaiCompatible');
const gemini = require('../../services/ai/adapters/gemini');
const ollama = require('../../services/ai/adapters/ollama');
const gateway = require('../../services/ai/gateway');
const vault = require('../../services/ai/credentialVault');
const { request } = require('../../services/ai/httpClient');

// One fake server that speaks all three protocols. `behaviour` lets a test
// force failures; `seen` records what the adapters actually sent.
let server;
let base;
let behaviour = {};
let seen = [];

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (behaviour.status) return send(res, behaviour.status, behaviour.body || {});
      if (behaviour.hang) return undefined;
      if (behaviour.redirect) return send(res, 302, '', { Location: 'http://169.254.169.254/' });
      if (behaviour.huge) return send(res, 200, 'x'.repeat(6 * 1024 * 1024));

      // OpenAI-compatible
      if (req.url === '/v1/models') {
        if (req.headers.authorization !== 'Bearer sk-good-key-123456') return send(res, 401, { error: { message: 'Incorrect API key provided: sk-good...' } });
        return send(res, 200, { data: [{ id: 'gpt-4.1-mini' }, { id: 'text-embedding-3-small' }, { id: 'whisper-1' }, { id: 'gpt-4.1' }] });
      }
      if (req.url === '/v1/chat/completions') {
        if (body.model === 'missing') return send(res, 404, { error: { message: 'The model `missing` does not exist' } });
        return send(res, 200, { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 1 } });
      }
      // Gemini
      if (req.url.startsWith('/v1beta/models?')) {
        if (req.headers['x-goog-api-key'] !== 'AIza-good') return send(res, 400, { error: { message: 'API key not valid. Please pass a valid API key.' } });
        return send(res, 200, { models: [
          { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        ] });
      }
      if (req.url === '/v1beta/models/gemini-2.5-flash:generateContent') {
        return send(res, 200, { candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } });
      }
      // Ollama
      if (req.url === '/api/tags') return send(res, 200, { models: [{ name: 'llama3.2:latest' }, { name: 'llava:latest' }, { name: 'nomic-embed-text:latest' }] });
      if (req.url === '/api/show') return send(res, 200, { capabilities: body.model.startsWith('llava') ? ['completion', 'vision'] : ['completion', 'tools'] });
      if (req.url === '/api/chat') {
        if (body.model === 'missing') return send(res, 404, { error: "model 'missing' not found" });
        return send(res, 200, { message: { role: 'assistant', content: 'OK' }, done_reason: 'stop', prompt_eval_count: 9, eval_count: 2 });
      }
      return send(res, 404, 'Not Found');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());
beforeEach(() => { behaviour = {}; seen = []; });

const conn = (extra = {}) => ({ providerType: 'custom', baseUrl: `${base}/v1`, apiKey: 'sk-good-key-123456', allowPrivate: true, timeoutMs: 2000, ...extra });

describe('OpenAI-compatible adapter', () => {
  test('lists chat models only', async () => {
    const models = await openai.listModels(conn());
    assert.deepEqual(models.map(m => m.id), ['gpt-4.1', 'gpt-4.1-mini']);
  });

  test('a wrong key is reported as invalid credentials without echoing it', async () => {
    await assert.rejects(openai.listModels(conn({ apiKey: 'sk-wrong-key-999999' })), (error) => {
      assert.equal(error.code, 'INVALID_CREDENTIALS');
      assert.ok(!JSON.stringify(error.toJSON()).includes('sk-wrong-key-999999'));
      return true;
    });
  });

  test('completes and reports usage', async () => {
    const result = await openai.complete(conn(), { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: 'hi' }], maxTokens: 10, temperature: 0.2 });
    assert.equal(result.text, 'OK');
    assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 1 });
    assert.equal(seen[0].body.max_tokens, 10);
    assert.equal(seen[0].body.temperature, 0.2);
  });

  test('uses max_completion_tokens for newer OpenAI models', async () => {
    await openai.complete(conn({ providerType: 'openai' }), { model: 'gpt-5-mini', messages: [{ role: 'user', content: 'hi' }], maxTokens: 10, temperature: 0.2 });
    assert.equal(seen[0].body.max_completion_tokens, 10);
    assert.equal(seen[0].body.temperature, undefined);
  });

  test('an unknown model is reported as such', async () => {
    await assert.rejects(openai.complete(conn(), { model: 'missing', messages: [{ role: 'user', content: 'hi' }] }), { code: 'MODEL_NOT_FOUND' });
  });
});

describe('Gemini adapter', () => {
  const g = (extra) => ({ providerType: 'gemini', baseUrl: `${base}/v1beta`, apiKey: 'AIza-good', allowPrivate: true, timeoutMs: 2000, ...extra });

  test('lists generateContent models and keeps the key out of the URL', async () => {
    const models = await gemini.listModels(g());
    assert.deepEqual(models, [{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }]);
    assert.ok(!seen[0].url.includes('AIza'));
  });

  test('a rejected key maps to invalid credentials', async () => {
    await assert.rejects(gemini.listModels(g({ apiKey: 'AIza-bad' })), { code: 'INVALID_CREDENTIALS' });
  });

  test('sends the system prompt separately and parses the answer', async () => {
    const result = await gemini.complete(g(), {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'system', content: 'Be brief' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }],
      maxTokens: 8,
    });
    assert.equal(result.text, 'OK');
    assert.equal(seen[0].body.systemInstruction.parts[0].text, 'Be brief');
    assert.deepEqual(seen[0].body.contents.map(c => c.role), ['user', 'model']);
  });
});

describe('Ollama adapter', () => {
  const o = (extra) => ({ providerType: 'ollama', baseUrl: base, apiKey: null, allowPrivate: true, timeoutMs: 2000, ...extra });

  test('lists models without embeddings and detects capabilities', async () => {
    assert.deepEqual((await ollama.listModels(o())).map(m => m.id), ['llama3.2:latest', 'llava:latest']);
    assert.equal((await ollama.describeModel(o(), 'llava:latest')).multimodal, true);
    assert.equal((await ollama.describeModel(o(), 'llama3.2:latest')).toolCalling, true);
  });

  test('completes', async () => {
    const result = await ollama.complete(o(), { model: 'llama3.2:latest', messages: [{ role: 'user', content: 'hi' }], maxTokens: 4 });
    assert.equal(result.text, 'OK');
    assert.equal(seen[0].body.options.num_predict, 4);
  });

  test('sends the Ollama Cloud key as a Bearer token', async () => {
    await ollama.listModels(o({ apiKey: 'ollama-cloud-key-abcdef12' }));
    assert.equal(seen[0].headers.authorization, 'Bearer ollama-cloud-key-abcdef12');
  });

  test('a missing model maps to MODEL_NOT_FOUND', async () => {
    await assert.rejects(ollama.complete(o(), { model: 'missing', messages: [{ role: 'user', content: 'hi' }] }), { code: 'MODEL_NOT_FOUND' });
  });
});

describe('HTTP client safety', () => {
  test('refuses private addresses unless allowed', async () => {
    await assert.rejects(request(`${base}/api/tags`, { allowPrivate: false }), { code: 'BLOCKED_ENDPOINT' });
    await assert.rejects(request(`http://localhost:${server.address().port}/api/tags`, { allowPrivate: false }), { code: 'BLOCKED_ENDPOINT' });
    assert.equal(seen.length, 0, 'no request may reach the server');
  });

  test('never follows redirects', async () => {
    behaviour.redirect = true;
    await assert.rejects(request(`${base}/api/tags`, { allowPrivate: true }), { code: 'UNEXPECTED_REDIRECT' });
  });

  test('times out', async () => {
    behaviour.hang = true;
    await assert.rejects(request(`${base}/api/tags`, { allowPrivate: true, timeoutMs: 200 }), { code: 'TIMEOUT' });
  });

  test('can be cancelled', async () => {
    behaviour.hang = true;
    const controller = new AbortController();
    const pending = request(`${base}/api/tags`, { allowPrivate: true, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, { code: 'CANCELLED' });
  });

  test('caps the response size', async () => {
    behaviour.huge = true;
    await assert.rejects(request(`${base}/api/tags`, { allowPrivate: true }), { code: 'RESPONSE_TOO_LARGE' });
  });

  test('connection refused is reported as unreachable', async () => {
    const closed = http.createServer();
    await new Promise(r => closed.listen(0, '127.0.0.1', r));
    const port = closed.address().port;
    await new Promise(r => closed.close(r));
    await assert.rejects(request(`http://127.0.0.1:${port}/`, { allowPrivate: true }), { code: 'UNREACHABLE' });
  });

  test('provider rate limits and outages map to clear errors', async () => {
    behaviour = { status: 429, body: { error: { message: 'Rate limit reached' } } };
    await assert.rejects(ollama.listModels({ baseUrl: base, allowPrivate: true }), { code: 'RATE_LIMITED' });
    behaviour = { status: 503, body: {} };
    await assert.rejects(ollama.listModels({ baseUrl: base, allowPrivate: true }), { code: 'PROVIDER_UNAVAILABLE' });
  });
});

describe('gateway connection test', () => {
  const userId = 'user-1';
  let saved;
  before(() => {
    saved = { key: process.env.AI_CREDENTIALS_KEY, priv: process.env.AI_ALLOW_PRIVATE_ENDPOINTS };
    process.env.AI_CREDENTIALS_KEY = crypto.randomBytes(32).toString('hex');
    process.env.AI_ALLOW_PRIVATE_ENDPOINTS = 'true';
  });
  after(() => {
    process.env.AI_CREDENTIALS_KEY = saved.key || '';
    process.env.AI_ALLOW_PRIVATE_ENDPOINTS = saved.priv || '';
  });

  const customConfig = (apiKey, extra = {}) => {
    const id = crypto.randomUUID();
    return {
      id, userId, providerType: 'custom', baseUrl: `${base}/v1`, enabled: true,
      encryptedApiKey: apiKey ? vault.encrypt(apiKey, { userId, providerId: id }) : null,
      ...extra,
    };
  };

  test('lists models and runs a tiny prompt on the chosen model', async () => {
    const result = await gateway.testConnection(customConfig('sk-good-key-123456'), 'gpt-4.1-mini');
    assert.equal(result.models.length, 2);
    assert.equal(result.modelAvailable, true);
    assert.equal(result.replyPreview, 'OK');
    assert.equal(seen[1].body.max_tokens, 16);
  });

  test('a required key that is missing fails before any request', async () => {
    const id = crypto.randomUUID();
    await assert.rejects(gateway.testConnection({ id, userId, providerType: 'groq', enabled: true }, null), { code: 'MISSING_CREDENTIALS' });
    assert.equal(seen.length, 0);
  });

  test('Ollama Cloud without a key fails before any request', async () => {
    const id = crypto.randomUUID();
    await assert.rejects(gateway.testConnection({ id, userId, providerType: 'ollama', baseUrl: 'https://ollama.com', enabled: true }, 'gpt-oss:20b'), { code: 'MISSING_CREDENTIALS' });
    assert.equal(seen.length, 0);
  });

  test('fixed-address providers ignore a stored base URL', () => {
    const id = crypto.randomUUID();
    const c = gateway.connectionFor({ id, userId, providerType: 'openai', baseUrl: `${base}/v1`, encryptedApiKey: vault.encrypt('sk-x-123456789', { userId, providerId: id }) });
    assert.equal(c.baseUrl, 'https://api.openai.com/v1');
    assert.equal(c.allowPrivate, false);
  });

  test('a feature that needs an unsupported capability is refused before sending', async () => {
    await assert.rejects(
      gateway.completeWith(customConfig('sk-good-key-123456'), 'gpt-4.1-mini', { messages: [{ role: 'user', content: 'x' }], requires: ['structuredOutput'] }),
      { code: 'UNSUPPORTED_CAPABILITY' },
    );
    assert.equal(seen.length, 0);
  });
});
