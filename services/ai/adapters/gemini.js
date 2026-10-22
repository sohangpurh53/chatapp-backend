const { request, parseJson } = require('../httpClient');
const { AiError, fromProviderResponse } = require('../errors');

// Google Gemini (Generative Language API). The key travels in the
// x-goog-api-key header, never in the URL, so it can't leak through logs.

const headers = (conn) => (conn.apiKey ? { 'x-goog-api-key': conn.apiKey } : {});

const call = async (conn, path, options, context = {}) => {
  const res = await request(`${conn.baseUrl}${path}`, {
    ...options,
    headers: headers(conn),
    allowPrivate: conn.allowPrivate,
    timeoutMs: options.timeoutMs || conn.timeoutMs,
  });
  if (res.status < 200 || res.status >= 300) {
    throw fromProviderResponse(res.status, res.text, { ...context, secrets: [conn.apiKey] });
  }
  return parseJson(res.text);
};

const stripPrefix = (name) => String(name || '').replace(/^models\//, '');

const listModels = async (conn, { signal } = {}) => {
  const models = [];
  let pageToken = '';
  // A few pages at most; the list is ~50 models today
  for (let page = 0; page < 5; page += 1) {
    const query = `?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const body = await call(conn, `/models${query}`, { method: 'GET', signal });
    if (!Array.isArray(body?.models)) throw new AiError('BAD_RESPONSE');
    models.push(...body.models);
    if (!body.nextPageToken) break;
    pageToken = body.nextPageToken;
  }
  return models
    .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
    .filter(m => !/embedding|imagen|aqa|tts|image-generation/i.test(m.name))
    .map(m => ({ id: stripPrefix(m.name), label: m.displayName || stripPrefix(m.name) }))
    .sort((a, b) => a.id.localeCompare(b.id));
};

const complete = async (conn, { model, messages, maxTokens, temperature, json, signal, timeoutMs }) => {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const generationConfig = {
    ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
    ...(typeof temperature === 'number' ? { temperature } : {}),
    ...(json ? { responseMimeType: 'application/json' } : {}),
  };
  const payload = {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
  };
  const path = `/models/${encodeURIComponent(stripPrefix(model))}:generateContent`;
  const body = await call(conn, path, { method: 'POST', body: payload, signal, timeoutMs }, { model });
  const candidate = body?.candidates?.[0];
  if (!candidate && body?.promptFeedback?.blockReason) {
    throw new AiError('BAD_REQUEST', 'The provider declined to answer this request.');
  }
  if (!candidate) throw new AiError('BAD_RESPONSE');
  return {
    text: (candidate.content?.parts || []).map(p => p.text || '').join(''),
    finishReason: candidate.finishReason || null,
    usage: {
      inputTokens: body.usageMetadata?.promptTokenCount ?? null,
      outputTokens: body.usageMetadata?.candidatesTokenCount ?? null,
    },
  };
};

module.exports = { listModels, complete };
