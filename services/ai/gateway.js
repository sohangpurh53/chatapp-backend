const { AiError } = require('./errors');
const registry = require('./registry');
const vault = require('./credentialVault');
const { privateEndpointsAllowed } = require('./urlGuard');
const { FEATURE_KEYS } = require('./settings');

// The one entry point AI features use. It resolves which provider and model a
// feature runs on and calls the matching adapter. It never falls back to a
// different provider: if the configured one is missing, disabled or failing,
// the caller gets an error, so private content is only ever sent to the
// service the user chose for that feature.

const ADAPTERS = {
  openai: require('./adapters/openaiCompatible'),
  gemini: require('./adapters/gemini'),
  ollama: require('./adapters/ollama'),
};

const adapterFor = (providerType) => {
  const def = registry.getProvider(providerType);
  if (!def) throw new AiError('PROVIDER_NOT_FOUND');
  return ADAPTERS[def.protocol];
};

/**
 * Pick the provider and model for a feature.
 * - The feature's own provider wins; otherwise the default provider.
 * - The model is the feature's model, else the default model when the
 *   provider is the default one, else the provider's own default model.
 * Pure function: `providers` are plain provider configurations.
 */
const resolveTarget = (settings, providers, feature) => {
  if (!settings.enabled) throw new AiError('AI_DISABLED');
  if (feature !== 'default') {
    if (!FEATURE_KEYS.includes(feature)) throw new AiError('VALIDATION_ERROR', `Unknown AI feature: ${feature}`);
    if (!settings.features[feature]?.enabled) throw new AiError('FEATURE_DISABLED');
  }
  const featureConfig = feature === 'default' ? {} : settings.features[feature];
  const providerId = featureConfig.providerId || settings.defaultProviderId;
  if (!providerId) throw new AiError('NO_PROVIDER');

  const provider = providers.find(p => p.id === providerId);
  if (!provider) throw new AiError('PROVIDER_NOT_FOUND');
  if (!provider.enabled) throw new AiError('PROVIDER_DISABLED');

  let model = featureConfig.model || null;
  if (!model && providerId === settings.defaultProviderId) model = settings.defaultModel;
  if (!model) model = provider.defaultModel;
  if (!model) throw new AiError('MODEL_REQUIRED');

  return { provider, model, source: featureConfig.providerId ? 'feature' : 'default' };
};

/** Decrypted connection details for one provider configuration. Never log this. */
const connectionFor = (config, { timeoutMs } = {}) => {
  const def = registry.getProvider(config.providerType);
  if (!def) throw new AiError('PROVIDER_NOT_FOUND');
  let apiKey = null;
  if (config.encryptedApiKey) {
    apiKey = vault.decrypt(config.encryptedApiKey, { userId: config.userId, providerId: config.id }).plaintext;
  }
  const baseUrl = (def.baseUrlEditable ? config.baseUrl : null) || def.defaultBaseUrl;
  if (!baseUrl) throw new AiError('INVALID_ENDPOINT');
  if (registry.requiresApiKey(config.providerType, baseUrl) && !apiKey) throw new AiError('MISSING_CREDENTIALS');
  return {
    providerType: config.providerType,
    baseUrl,
    apiKey,
    allowPrivate: def.baseUrlEditable && privateEndpointsAllowed(),
    timeoutMs,
  };
};

const listModels = (config, options = {}) =>
  adapterFor(config.providerType).listModels(connectionFor(config, options), options);

/**
 * Run a completion on one provider configuration.
 * `requires` lists capabilities the caller depends on (e.g. structuredOutput).
 */
const completeWith = async (config, model, request) => {
  if (!registry.isValidModelId(model)) throw new AiError('INVALID_MODEL');
  const capabilities = registry.effectiveCapabilities(config, model);
  for (const capability of request.requires || []) {
    if (!capabilities[capability]) throw new AiError('UNSUPPORTED_CAPABILITY');
  }
  const conn = connectionFor(config, { timeoutMs: request.timeoutMs });
  return adapterFor(config.providerType).complete(conn, { ...request, model });
};

/**
 * Check a configuration: list models (proves the address and key) and, when a
 * model is given, send a tiny prompt to prove that model answers.
 */
const testConnection = async (config, model, { signal } = {}) => {
  const def = registry.getProvider(config.providerType);
  const started = Date.now();
  const adapter = adapterFor(config.providerType);
  const conn = connectionFor(config, { timeoutMs: 20000 });

  let models = null;
  if (def.modelDiscovery) {
    try {
      models = await adapter.listModels(conn, { signal });
    } catch (error) {
      // Some compatible servers have no /models; a working completion still proves the setup
      if (!(config.providerType === 'custom' && error.code === 'ENDPOINT_NOT_FOUND' && model)) throw error;
    }
  }

  let modelCapabilities = null;
  let reply = null;
  if (model) {
    if (!registry.isValidModelId(model)) throw new AiError('INVALID_MODEL');
    if (adapter.describeModel) {
      modelCapabilities = await adapter.describeModel(conn, model, { signal }).catch(() => null);
    }
    const result = await adapter.complete(conn, {
      model,
      messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
      maxTokens: 16,
      signal,
    });
    reply = (result.text || '').trim().slice(0, 40);
  }

  return {
    latencyMs: Date.now() - started,
    models,
    modelAvailable: model && models ? models.some(m => m.id === model) : null,
    modelCapabilities,
    replyPreview: reply,
  };
};

module.exports = { resolveTarget, connectionFor, listModels, completeWith, testConnection, ADAPTERS };
