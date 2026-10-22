const { request, parseJson } = require('../httpClient');
const { AiError, fromProviderResponse } = require('../errors');

// OpenAI Chat Completions protocol: OpenAI, Groq, xAI and any compatible
// endpoint (vLLM, LM Studio, LiteLLM, OpenRouter, Together, ...).

// Models in /models that can't do chat completions
const NON_CHAT = /(embedding|embed|tts|whisper|transcribe|dall-e|gpt-image|moderation|davinci|babbage|realtime|audio|search|computer-use|-image|imagen|guard|distil-whisper)/i;

const authHeaders = (conn) => (conn.apiKey ? { Authorization: `Bearer ${conn.apiKey}` } : {});

const call = async (conn, path, options, context = {}) => {
  const res = await request(`${conn.baseUrl}${path}`, {
    ...options,
    headers: { ...authHeaders(conn), ...(options.headers || {}) },
    allowPrivate: conn.allowPrivate,
    timeoutMs: options.timeoutMs || conn.timeoutMs,
  });
  if (res.status < 200 || res.status >= 300) {
    throw fromProviderResponse(res.status, res.text, { ...context, secrets: [conn.apiKey] });
  }
  return parseJson(res.text);
};

const listModels = async (conn, { signal } = {}) => {
  const body = await call(conn, '/models', { method: 'GET', signal });
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : null;
  if (!list) throw new AiError('BAD_RESPONSE');
  return list
    .map(m => (typeof m === 'string' ? m : m?.id))
    .filter(id => typeof id === 'string' && id && !NON_CHAT.test(id))
    .sort((a, b) => a.localeCompare(b))
    .map(id => ({ id, label: id }));
};

/** OpenAI's newer models want max_completion_tokens and reject custom temperature. */
const usesCompletionTokens = (conn, model) =>
  conn.providerType === 'openai' && /^(o\d|gpt-5)/i.test(model);

const complete = async (conn, { model, messages, maxTokens, temperature, json, signal, timeoutMs }) => {
  const modern = usesCompletionTokens(conn, model);
  const payload = {
    model,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    stream: false,
    ...(maxTokens ? (modern ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }) : {}),
    ...(typeof temperature === 'number' && !modern ? { temperature } : {}),
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  };
  const body = await call(conn, '/chat/completions', { method: 'POST', body: payload, signal, timeoutMs }, { model });
  const choice = body?.choices?.[0];
  if (!choice) throw new AiError('BAD_RESPONSE');
  const content = choice.message?.content;
  const text = Array.isArray(content)
    ? content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('')
    : (content || '');
  return {
    text,
    finishReason: choice.finish_reason || null,
    usage: {
      inputTokens: body.usage?.prompt_tokens ?? null,
      outputTokens: body.usage?.completion_tokens ?? null,
    },
  };
};

module.exports = { listModels, complete };
