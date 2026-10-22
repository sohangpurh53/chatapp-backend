const { request, parseJson } = require('../httpClient');
const { AiError, fromProviderResponse } = require('../errors');

// Ollama native API (/api/tags, /api/show, /api/chat). Works for a self-hosted
// server and for Ollama Cloud (https://ollama.com with a Bearer key).

const authHeaders = (conn) => (conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {});

const call = async (conn, path, options, context = {}) => {
  const res = await request(`${conn.baseUrl}${path}`, {
    ...options,
    headers: authHeaders(conn),
    allowPrivate: conn.allowPrivate,
    timeoutMs: options.timeoutMs || conn.timeoutMs,
  });
  if (res.status < 200 || res.status >= 300) {
    throw fromProviderResponse(res.status, res.text, { ...context, secrets: [conn.apiKey] });
  }
  return parseJson(res.text);
};

const listModels = async (conn, { signal } = {}) => {
  const body = await call(conn, '/api/tags', { method: 'GET', signal });
  if (!Array.isArray(body?.models)) throw new AiError('BAD_RESPONSE');
  return body.models
    .map(m => m?.name || m?.model)
    .filter(name => typeof name === 'string' && name && !/embed/i.test(name))
    .sort((a, b) => a.localeCompare(b))
    .map(id => ({ id, label: id }));
};

/** Newer Ollama versions report what a model can do; older ones return null here. */
const describeModel = async (conn, model, { signal } = {}) => {
  const body = await call(conn, '/api/show', { method: 'POST', body: { model }, signal }, { model });
  if (!Array.isArray(body?.capabilities)) return null;
  const caps = body.capabilities;
  return {
    streaming: true,
    structuredOutput: caps.includes('completion'),
    toolCalling: caps.includes('tools'),
    multimodal: caps.includes('vision'),
  };
};

const complete = async (conn, { model, messages, maxTokens, temperature, json, signal, timeoutMs, lowReasoning }) => {
  const options = {
    ...(maxTokens ? { num_predict: maxTokens } : {}),
    ...(typeof temperature === 'number' ? { temperature } : {}),
  };
  const payload = {
    model,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    stream: false,
    ...(json ? { format: 'json' } : {}),
    // gpt-oss on Ollama takes a thinking level; other thinking models take true/false
    ...(lowReasoning && /gpt-oss/i.test(model) ? { think: 'low' } : {}),
    ...(Object.keys(options).length ? { options } : {}),
  };
  const body = await call(conn, '/api/chat', { method: 'POST', body: payload, signal, timeoutMs }, { model });
  if (!body?.message) throw new AiError('BAD_RESPONSE');
  return {
    text: body.message.content || '',
    finishReason: body.done_reason || null,
    usage: {
      inputTokens: body.prompt_eval_count ?? null,
      outputTokens: body.eval_count ?? null,
    },
  };
};

module.exports = { listModels, describeModel, complete };
