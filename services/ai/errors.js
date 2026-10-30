// Errors raised by the AI provider layer. Every message here is safe to show
// to the user: provider responses are redacted before they reach `message`.

const MESSAGES = {
  AI_DISABLED: 'AI is turned off. Turn it on under Settings > AI & Models.',
  FEATURE_DISABLED: 'This AI feature is turned off.',
  NO_PROVIDER: 'No AI provider is selected for this feature.',
  PROVIDER_NOT_FOUND: 'That AI provider no longer exists.',
  PROVIDER_DISABLED: 'The selected AI provider is disabled.',
  MODEL_REQUIRED: 'Choose a model for this provider first.',
  INVALID_MODEL: 'That model name is not valid.',
  MISSING_CREDENTIALS: 'This provider needs an API key.',
  INVALID_CREDENTIALS: 'The provider rejected the API key. Check that it is correct and has not expired.',
  PERMISSION_DENIED: 'The API key is valid but is not allowed to use this resource.',
  MODEL_NOT_FOUND: 'The provider does not offer that model, or the key cannot access it.',
  ENDPOINT_NOT_FOUND: 'Nothing answered at that API address. Check the base URL.',
  RATE_LIMITED: 'The provider is rate limiting requests. Try again in a moment.',
  QUOTA_EXCEEDED: 'The provider account has run out of quota or credit.',
  PROVIDER_UNAVAILABLE: 'The provider is having problems right now. Try again later.',
  TIMEOUT: 'The provider took too long to answer.',
  UNREACHABLE: 'Could not connect to the provider. Check the address and that the service is running.',
  INVALID_ENDPOINT: 'That API address is not valid.',
  BLOCKED_ENDPOINT: 'That API address points to a private or reserved network and is not allowed.',
  INSECURE_ENDPOINT: 'Plain HTTP is only allowed for self-hosted endpoints on a private network.',
  UNEXPECTED_REDIRECT: 'The provider tried to redirect the request, which is not allowed.',
  RESPONSE_TOO_LARGE: 'The provider sent a response that was too large.',
  BAD_RESPONSE: 'The provider sent a response that could not be understood.',
  BAD_REQUEST: 'The provider rejected the request.',
  CANCELLED: 'The request was cancelled.',
  UNSUPPORTED_CAPABILITY: 'The selected model does not support what this feature needs.',
  VAULT_NOT_CONFIGURED: 'The server cannot store API keys yet: AI_CREDENTIALS_KEY is not set.',
  VAULT_DECRYPT_FAILED: 'The stored API key could not be read. Enter it again.',
  VALIDATION_ERROR: 'Some settings are not valid.',
  CONSENT_REQUIRED: 'Allow this AI provider to receive this kind of text first.',
  GAME_REFUSED: "That game can't be made. Try a different idea.",
  CONTEXT_DISABLED: 'Conversation context is turned off in your AI privacy settings.',
  GROUP_AI_DISABLED: "This group's admins have turned off AI features for the group's messages.",
  LIMIT_REACHED: 'You have reached the maximum number of AI providers.',
};

// HTTP status our API answers with for each code
const STATUS = {
  AI_DISABLED: 409,
  FEATURE_DISABLED: 409,
  NO_PROVIDER: 409,
  PROVIDER_NOT_FOUND: 404,
  PROVIDER_DISABLED: 409,
  MODEL_REQUIRED: 400,
  INVALID_MODEL: 400,
  MISSING_CREDENTIALS: 400,
  INVALID_ENDPOINT: 400,
  BLOCKED_ENDPOINT: 400,
  INSECURE_ENDPOINT: 400,
  VALIDATION_ERROR: 400,
  CONSENT_REQUIRED: 409,
  GAME_REFUSED: 422,
  CONTEXT_DISABLED: 409,
  GROUP_AI_DISABLED: 403,
  LIMIT_REACHED: 400,
  UNSUPPORTED_CAPABILITY: 409,
  VAULT_NOT_CONFIGURED: 503,
  CANCELLED: 499,
};

class AiError extends Error {
  constructor(code, message, extra = {}) {
    super(message || MESSAGES[code] || 'AI request failed');
    this.name = 'AiError';
    this.code = code;
    this.status = extra.status || STATUS[code] || 502;
    if (extra.providerStatus) this.providerStatus = extra.providerStatus;
    if (extra.detail) this.detail = extra.detail;
    // Structured, non-secret data for the app (e.g. which consent is needed)
    if (extra.data) this.data = extra.data;
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}), ...(this.data ? { data: this.data } : {}) };
  }

  /** Body for an API error response. */
  toResponse() {
    return { error: this.message, code: this.code, ...(this.detail ? { detail: this.detail } : {}), ...(this.data ? { data: this.data } : {}) };
  }
}

// Shapes of common API keys and auth headers, so they never reach logs or clients
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_\-]{8,}/g,
  /\bgsk_[A-Za-z0-9]{8,}/g,
  /\bxai-[A-Za-z0-9]{8,}/g,
  /\bAIza[0-9A-Za-z_\-]{20,}/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=\-]{8,}/gi,
  /([?&](key|api_key|apikey|token)=)[^&\s"']+/gi,
];

/** Strip API keys (known shapes plus the exact secrets given) from a string. */
const redact = (text, secrets = []) => {
  if (text == null) return text;
  let out = String(text);
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, p1) => (p1 && /[?&]/.test(p1) ? `${p1}[redacted]` : '[redacted]'));
  }
  return out;
};

/** Pull the human-readable error out of a provider's JSON error body. */
const providerMessageOf = (bodyText) => {
  if (!bodyText) return '';
  try {
    const body = JSON.parse(bodyText);
    const err = Array.isArray(body) ? body[0]?.error : body.error;
    if (typeof err === 'string') return err;
    if (err && typeof err.message === 'string') return err.message;
    if (typeof body.message === 'string') return body.message;
    if (typeof body.detail === 'string') return body.detail;
  } catch {
    // not JSON
  }
  return '';
};

/**
 * Turn a non-2xx provider response into an AiError with a clear code.
 * `context.model` tells a "model not found" 404 apart from a wrong base URL.
 */
const fromProviderResponse = (status, bodyText, context = {}) => {
  const raw = providerMessageOf(bodyText);
  const detail = raw ? redact(raw, context.secrets).slice(0, 300) : undefined;
  const lower = (raw || '').toLowerCase();
  const extra = { providerStatus: status, detail };

  if (status === 401 || /api[_ ]?key (not valid|invalid)|invalid api key|api_key_invalid|incorrect api key|invalid x-api-key/.test(lower)) {
    return new AiError('INVALID_CREDENTIALS', undefined, extra);
  }
  if (status === 403) {
    if (/quota|billing|credit/.test(lower)) return new AiError('QUOTA_EXCEEDED', undefined, extra);
    return new AiError('PERMISSION_DENIED', undefined, extra);
  }
  if (status === 404) {
    if (context.model || /model/.test(lower)) return new AiError('MODEL_NOT_FOUND', undefined, extra);
    return new AiError('ENDPOINT_NOT_FOUND', undefined, extra);
  }
  if (status === 402 || /insufficient_quota|exceeded your current quota|out of credits|credit balance/.test(lower)) {
    return new AiError('QUOTA_EXCEEDED', undefined, extra);
  }
  if (status === 429) return new AiError('RATE_LIMITED', undefined, extra);
  if (status === 408 || status === 504) return new AiError('TIMEOUT', undefined, extra);
  if (status >= 500) return new AiError('PROVIDER_UNAVAILABLE', undefined, extra);
  if (/model.*(not found|does not exist|not supported|decommissioned)/.test(lower)) {
    return new AiError('MODEL_NOT_FOUND', undefined, extra);
  }
  return new AiError('BAD_REQUEST', detail ? `The provider rejected the request: ${detail}` : undefined, extra);
};

module.exports = { AiError, MESSAGES, redact, fromProviderResponse, providerMessageOf };
