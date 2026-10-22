// Provider catalogue. AI features never talk to a vendor directly: they ask the
// gateway, which picks the adapter for the configured provider's `protocol`.
//
// `capabilities` are the defaults for the provider. Model discovery can refine
// them per model (Ollama reports them), and the user can override any of them
// on a provider configuration. Unknown endpoints (custom) default to the safe
// minimum: plain text completions only.

const CAPABILITY_KEYS = ['streaming', 'structuredOutput', 'toolCalling', 'multimodal'];

const CAPABILITY_LABELS = {
  streaming: 'Streaming responses',
  structuredOutput: 'Structured (JSON) output',
  toolCalling: 'Tool calling',
  multimodal: 'Image input',
};

const PROVIDERS = {
  openai: {
    type: 'openai',
    label: 'OpenAI',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    baseUrlEditable: false,
    apiKey: 'required',
    deployment: 'cloud',
    modelDiscovery: true,
    suggestedModels: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini'],
    keyHelp: 'Create a key at platform.openai.com/api-keys.',
    capabilities: { streaming: true, structuredOutput: true, toolCalling: true, multimodal: true },
  },
  gemini: {
    type: 'gemini',
    label: 'Google Gemini',
    protocol: 'gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    baseUrlEditable: false,
    apiKey: 'required',
    deployment: 'cloud',
    modelDiscovery: true,
    suggestedModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    keyHelp: 'Create a key in Google AI Studio (aistudio.google.com).',
    capabilities: { streaming: true, structuredOutput: true, toolCalling: true, multimodal: true },
  },
  groq: {
    type: 'groq',
    label: 'Groq',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    baseUrlEditable: false,
    apiKey: 'required',
    deployment: 'cloud',
    modelDiscovery: true,
    suggestedModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    keyHelp: 'Create a key at console.groq.com/keys.',
    capabilities: { streaming: true, structuredOutput: true, toolCalling: true, multimodal: false },
  },
  xai: {
    type: 'xai',
    label: 'xAI (Grok)',
    protocol: 'openai',
    defaultBaseUrl: 'https://api.x.ai/v1',
    baseUrlEditable: false,
    apiKey: 'required',
    deployment: 'cloud',
    modelDiscovery: true,
    suggestedModels: ['grok-3-mini', 'grok-3'],
    keyHelp: 'Create a key at console.x.ai.',
    capabilities: { streaming: true, structuredOutput: true, toolCalling: true, multimodal: false },
  },
  ollama: {
    type: 'ollama',
    label: 'Ollama',
    protocol: 'ollama',
    // Ollama Cloud by default; the address can point at a self-hosted server instead
    defaultBaseUrl: 'https://ollama.com',
    baseUrlEditable: true,
    apiKey: 'optional',
    // Ollama Cloud always needs a key; a self-hosted server usually doesn't
    keyRequiredHosts: ['ollama.com'],
    deployment: 'cloud',
    modelDiscovery: true,
    suggestedModels: ['gpt-oss:120b', 'gpt-oss:20b', 'deepseek-v3.1:671b'],
    keyHelp: 'Ollama Cloud needs a key from ollama.com/settings/keys. A self-hosted server usually needs none.',
    urlHelp: 'Leave as https://ollama.com for Ollama Cloud, or enter your own Ollama server address.',
    capabilities: { streaming: true, structuredOutput: true, toolCalling: true, multimodal: false },
  },
  custom: {
    type: 'custom',
    label: 'Custom (OpenAI-compatible)',
    protocol: 'openai',
    defaultBaseUrl: null,
    baseUrlEditable: true,
    apiKey: 'optional',
    deployment: 'declared',
    modelDiscovery: true,
    suggestedModels: [],
    keyHelp: 'Leave empty if the endpoint does not need a key.',
    urlHelp: 'The base URL that ends before /chat/completions, for example https://api.example.com/v1.',
    capabilities: { streaming: false, structuredOutput: false, toolCalling: false, multimodal: false },
  },
};

const getProvider = (type) => PROVIDERS[type] || null;

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};

/** Does this configuration need an API key? (Ollama Cloud does, a self-hosted Ollama doesn't.) */
const requiresApiKey = (type, baseUrl) => {
  const def = getProvider(type);
  if (!def) return false;
  if (def.apiKey === 'required') return true;
  const host = hostOf(baseUrl || def.defaultBaseUrl || '');
  return (def.keyRequiredHosts || []).some(h => host === h || host.endsWith(`.${h}`));
};

/** Public catalogue for the app. */
const catalog = () => Object.values(PROVIDERS).map(p => ({
  type: p.type,
  label: p.label,
  defaultBaseUrl: p.defaultBaseUrl,
  baseUrlEditable: p.baseUrlEditable,
  apiKey: p.apiKey,
  keyRequiredHosts: p.keyRequiredHosts || [],
  deployment: p.deployment,
  modelDiscovery: p.modelDiscovery,
  suggestedModels: p.suggestedModels,
  keyHelp: p.keyHelp,
  urlHelp: p.urlHelp || null,
  capabilities: p.capabilities,
}));

/**
 * Where a configuration sends data: 'cloud' (a third-party service) or
 * 'self_hosted' (a server the user or operator runs). For custom endpoints the
 * user declares it; private addresses are always self-hosted.
 */
const deploymentOf = (config) => {
  const def = getProvider(config.providerType);
  if (!def) return 'cloud';
  let host = '';
  try {
    host = new URL(config.baseUrl || def.defaultBaseUrl || '').hostname.toLowerCase();
  } catch {
    // keep empty
  }
  if (def.type === 'ollama') return /(^|\.)ollama\.com$/.test(host) ? 'cloud' : 'self_hosted';
  if (def.deployment === 'declared') {
    const { classifyAddress } = require('./urlGuard');
    const bare = host.replace(/^\[|\]$/g, '');
    if (bare === 'localhost' || (require('net').isIP(bare) && classifyAddress(bare) === 'private')) return 'self_hosted';
    return config.deploymentType === 'self_hosted' ? 'self_hosted' : 'cloud';
  }
  return def.deployment;
};

/** Defaults, then what the provider reported for the model, then the user's overrides. */
const effectiveCapabilities = (config, model) => {
  const def = getProvider(config.providerType);
  const base = { ...(def ? def.capabilities : {}) };
  const modelId = model || config.defaultModel;
  const discovered = Array.isArray(config.models)
    ? config.models.find(m => m && m.id === modelId)?.capabilities
    : null;
  const overrides = config.capabilityOverrides || {};
  const result = {};
  for (const key of CAPABILITY_KEYS) {
    let value = !!base[key];
    if (discovered && typeof discovered[key] === 'boolean') value = discovered[key];
    if (typeof overrides[key] === 'boolean') value = overrides[key];
    result[key] = value;
  }
  return result;
};

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+\-\/]{0,199}$/;

/** Model identifiers go into URLs and request bodies: keep them boring. */
const isValidModelId = (value) =>
  typeof value === 'string' && MODEL_ID_RE.test(value) && !value.includes('..') && !value.includes('//');

module.exports = {
  PROVIDERS,
  CAPABILITY_KEYS,
  CAPABILITY_LABELS,
  getProvider,
  requiresApiKey,
  catalog,
  deploymentOf,
  effectiveCapabilities,
  isValidModelId,
};
