const crypto = require('crypto');
const sequelize = require('../config/database');
const { AiProviderConfig, AiUserSettings } = require('../models');
const { AiError, redact } = require('../services/ai/errors');
const registry = require('../services/ai/registry');
const vault = require('../services/ai/credentialVault');
const aiSettings = require('../services/ai/settings');
const gateway = require('../services/ai/gateway');
const { validateBaseUrl, privateEndpointsAllowed } = require('../services/ai/urlGuard');

// AI & Models settings API (stage 1: provider configuration only).
// Rules: API keys are write-only; every lookup is scoped to req.user; the
// server never switches a feature to another provider on its own.

const MAX_PROVIDERS_PER_USER = Math.max(1, parseInt(process.env.AI_MAX_PROVIDERS_PER_USER || '20', 10));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sendError = (res, error, fallback) => {
  if (error instanceof AiError) {
    return res.status(error.status).json({ error: error.message, code: error.code, ...(error.detail ? { detail: error.detail } : {}) });
  }
  // Log the kind of failure only: request bodies may hold API keys
  console.error(`[AI] ${fallback}:`, error?.name, redact(error?.message || ''));
  return res.status(500).json({ error: fallback });
};

/** API output for a provider row. The API key itself is never included. */
const serializeProvider = (row) => {
  const json = typeof row.get === 'function' ? row.get({ plain: true }) : { ...row };
  const def = registry.getProvider(json.providerType);
  return {
    id: json.id,
    providerType: json.providerType,
    label: json.label,
    baseUrl: def?.baseUrlEditable ? json.baseUrl : def?.defaultBaseUrl || null,
    hasApiKey: !!json.apiKeyHint,
    apiKeyHint: json.apiKeyHint || null,
    defaultModel: json.defaultModel || null,
    enabled: !!json.enabled,
    deployment: registry.deploymentOf(json),
    deploymentType: json.deploymentType || null,
    capabilities: registry.effectiveCapabilities(json),
    capabilityOverrides: json.capabilityOverrides || {},
    models: Array.isArray(json.models) ? json.models : [],
    modelsFetchedAt: json.modelsFetchedAt || null,
    status: json.status || 'untested',
    lastError: json.lastError || null,
    lastTestedAt: json.lastTestedAt || null,
    createdAt: json.createdAt,
    updatedAt: json.updatedAt,
  };
};

const loadSettings = async (userId, transaction) =>
  aiSettings.normalize(await AiUserSettings.findByPk(userId, { transaction }));

const saveSettings = async (userId, settings, transaction) => {
  await AiUserSettings.upsert({ userId, ...settings }, { transaction });
  return settings;
};

const listProviders = (userId) =>
  AiProviderConfig.findAll({ where: { userId }, order: [['createdAt', 'ASC']] });

const findOwnedProvider = async (req, { withSecret = false } = {}) => {
  const { providerId } = req.params;
  if (!UUID_RE.test(providerId || '')) throw new AiError('PROVIDER_NOT_FOUND');
  const model = withSecret ? AiProviderConfig.scope('withSecret') : AiProviderConfig;
  const row = await model.findOne({ where: { id: providerId, userId: req.user.id } });
  if (!row) throw new AiError('PROVIDER_NOT_FOUND');
  return row;
};

const invalid = (message) => new AiError('VALIDATION_ERROR', message);

const cleanApiKey = (value) => {
  if (typeof value !== 'string') throw invalid('The API key must be text.');
  const key = value.trim();
  if (!key) return null;
  if (key.length > 512 || /\s/.test(key)) throw invalid('That does not look like an API key.');
  return key;
};

/**
 * Validate a create/update body into column values. `existing` is the stored
 * row on update. Returns { values, newApiKey, clearApiKey, connectionChanged }.
 */
const parseProviderInput = (body, def, existing) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Expected a JSON object.');
  const values = {};
  let connectionChanged = false;

  if (!existing || 'label' in body) {
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    if (label.length > 60) throw invalid('The name can be at most 60 characters.');
    values.label = label || def.label;
  }

  if (def.baseUrlEditable && (!existing || 'baseUrl' in body)) {
    const raw = typeof body.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl : def.defaultBaseUrl;
    if (!raw) throw new AiError('INVALID_ENDPOINT', 'Enter the API base URL.');
    values.baseUrl = validateBaseUrl(raw, { allowPrivate: privateEndpointsAllowed() });
    if (existing && values.baseUrl !== existing.baseUrl) connectionChanged = true;
  }

  let newApiKey = null;
  let clearApiKey = false;
  if ('apiKey' in body && body.apiKey !== null && body.apiKey !== undefined) {
    newApiKey = cleanApiKey(body.apiKey);
    if (newApiKey) connectionChanged = true;
  }
  if (body.clearApiKey === true) {
    if (def.apiKey === 'required') throw invalid(`${def.label} needs an API key; enter a new one to replace it.`);
    clearApiKey = true;
    newApiKey = null;
    connectionChanged = true;
  }
  const effectiveUrl = values.baseUrl || existing?.baseUrl || def.defaultBaseUrl;
  const keyNeeded = registry.requiresApiKey(def.type, effectiveUrl);
  const hasKey = !!newApiKey || (!!existing?.apiKeyHint && !clearApiKey);
  if (keyNeeded && !hasKey) {
    throw new AiError('MISSING_CREDENTIALS', def.apiKey === 'required' ? undefined : 'Ollama Cloud needs an API key.');
  }

  if ('defaultModel' in body) {
    const model = typeof body.defaultModel === 'string' ? body.defaultModel.trim() : body.defaultModel;
    if (model === null || model === '' || model === undefined) values.defaultModel = null;
    else if (!registry.isValidModelId(model)) throw new AiError('INVALID_MODEL');
    else values.defaultModel = model;
  }

  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') throw invalid('enabled must be true or false.');
    values.enabled = body.enabled;
  }

  if (def.deployment === 'declared' && (!existing || 'deploymentType' in body)) {
    const declared = body.deploymentType || 'cloud';
    if (!['cloud', 'self_hosted'].includes(declared)) throw invalid('deploymentType must be cloud or self_hosted.');
    values.deploymentType = declared;
  }

  if ('capabilityOverrides' in body) {
    const input = body.capabilityOverrides;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('capabilityOverrides must be an object.');
    const next = { ...(existing?.capabilityOverrides || {}) };
    for (const [key, value] of Object.entries(input)) {
      if (!registry.CAPABILITY_KEYS.includes(key)) throw invalid(`Unknown capability: ${key}.`);
      if (value === null) delete next[key];
      else if (typeof value === 'boolean') next[key] = value;
      else throw invalid(`${key} must be true, false or null.`);
    }
    values.capabilityOverrides = next;
  }

  return { values, newApiKey, clearApiKey, connectionChanged };
};

/** Old-key ciphertext gets re-encrypted with the current key when it is next used. */
const rewrapIfNeeded = async (row) => {
  if (!row.encryptedApiKey || !vault.isConfigured()) return;
  const context = { userId: row.userId, providerId: row.id };
  const { plaintext, needsRotation } = vault.decrypt(row.encryptedApiKey, context);
  if (needsRotation) await row.update({ encryptedApiKey: vault.encrypt(plaintext, context) });
};

// GET /ai/config: everything the AI & Models screen needs in one request
const getConfig = async (req, res) => {
  try {
    const [settings, providers] = await Promise.all([loadSettings(req.user.id), listProviders(req.user.id)]);
    res.json({
      settings,
      providers: providers.map(serializeProvider),
      catalog: registry.catalog(),
      features: aiSettings.FEATURES,
      capabilityLabels: registry.CAPABILITY_LABELS,
      server: {
        credentialStorage: vault.isConfigured(),
        privateEndpointsAllowed: privateEndpointsAllowed(),
        maxProviders: MAX_PROVIDERS_PER_USER,
      },
    });
  } catch (error) {
    sendError(res, error, 'Failed to load AI settings');
  }
};

// PUT /ai/settings: partial update (global switch, defaults, features, limits)
const updateSettings = async (req, res) => {
  try {
    const providers = await listProviders(req.user.id);
    const current = await loadSettings(req.user.id);
    const next = aiSettings.applyUpdate(current, req.body, new Set(providers.map(p => p.id)));
    await saveSettings(req.user.id, next);
    res.json({ settings: next });
  } catch (error) {
    sendError(res, error, 'Failed to save AI settings');
  }
};

// POST /ai/providers
const createProvider = async (req, res) => {
  try {
    const def = registry.getProvider(req.body?.providerType);
    if (!def) throw invalid('Choose a supported provider.');
    const count = await AiProviderConfig.count({ where: { userId: req.user.id } });
    if (count >= MAX_PROVIDERS_PER_USER) throw new AiError('LIMIT_REACHED');

    const { values, newApiKey } = parseProviderInput(req.body, def, null);
    const id = crypto.randomUUID();
    const row = await AiProviderConfig.create({
      id,
      userId: req.user.id,
      providerType: def.type,
      enabled: true,
      capabilityOverrides: {},
      ...values,
      ...(newApiKey ? {
        encryptedApiKey: vault.encrypt(newApiKey, { userId: req.user.id, providerId: id }),
        apiKeyHint: vault.hintFor(newApiKey),
      } : {}),
      status: 'untested',
    });

    // The first provider becomes the default, so AI works once switched on
    let settings = await loadSettings(req.user.id);
    if (!settings.defaultProviderId) {
      settings = { ...settings, defaultProviderId: row.id, defaultModel: row.defaultModel || null };
      await saveSettings(req.user.id, settings);
    }

    res.status(201).json({ provider: serializeProvider(row), settings });
  } catch (error) {
    sendError(res, error, 'Failed to add AI provider');
  }
};

// PUT /ai/providers/:providerId
const updateProvider = async (req, res) => {
  try {
    const row = await findOwnedProvider(req);
    const def = registry.getProvider(row.providerType);
    if ('providerType' in (req.body || {}) && req.body.providerType !== row.providerType) {
      throw invalid('The provider type cannot be changed. Add a new provider instead.');
    }
    const { values, newApiKey, clearApiKey, connectionChanged } = parseProviderInput(req.body, def, row);
    if (newApiKey) {
      values.encryptedApiKey = vault.encrypt(newApiKey, { userId: row.userId, providerId: row.id });
      values.apiKeyHint = vault.hintFor(newApiKey);
    } else if (clearApiKey) {
      values.encryptedApiKey = null;
      values.apiKeyHint = null;
    }
    if (connectionChanged) {
      // Results from the old address or key no longer say anything
      Object.assign(values, { status: 'untested', lastError: null, lastTestedAt: null, models: null, modelsFetchedAt: null });
    }
    await row.update(values);
    res.json({ provider: serializeProvider(row) });
  } catch (error) {
    sendError(res, error, 'Failed to update AI provider');
  }
};

// DELETE /ai/providers/:providerId: also forgets every setting that pointed at it
const deleteProvider = async (req, res) => {
  try {
    const row = await findOwnedProvider(req);
    const settings = await sequelize.transaction(async (transaction) => {
      await row.destroy({ transaction });
      const current = await loadSettings(req.user.id, transaction);
      return saveSettings(req.user.id, aiSettings.withoutProvider(current, row.id), transaction);
    });
    res.json({ success: true, settings });
  } catch (error) {
    sendError(res, error, 'Failed to remove AI provider');
  }
};

/** Store a discovered model list, keeping capabilities learned for a model. */
const mergeModels = (previous, discovered, model, modelCapabilities) => {
  const known = new Map((previous || []).map(m => [m.id, m]));
  const list = discovered.map(m => ({ ...m, ...(known.get(m.id)?.capabilities ? { capabilities: known.get(m.id).capabilities } : {}) }));
  if (model && modelCapabilities) {
    const target = list.find(m => m.id === model);
    if (target) target.capabilities = modelCapabilities;
  }
  return list.slice(0, 500);
};

// POST /ai/providers/:providerId/test  { model? }
const testProvider = async (req, res) => {
  try {
    const row = await findOwnedProvider(req, { withSecret: true });
    const requested = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
    const model = requested || row.defaultModel || null;
    if (model && !registry.isValidModelId(model)) throw new AiError('INVALID_MODEL');

    try {
      await rewrapIfNeeded(row);
      const result = await gateway.testConnection(row.get({ plain: true }), model);
      const updates = { status: 'ok', lastError: null, lastTestedAt: new Date() };
      if (result.models) {
        updates.models = mergeModels(row.models, result.models, model, result.modelCapabilities);
        updates.modelsFetchedAt = new Date();
      }
      await row.update(updates);
      res.json({
        ok: true,
        latencyMs: result.latencyMs,
        model,
        modelCount: result.models ? result.models.length : null,
        modelAvailable: result.modelAvailable,
        replyPreview: result.replyPreview,
        provider: serializeProvider(row),
      });
    } catch (error) {
      if (!(error instanceof AiError)) throw error;
      await row.update({ status: 'error', lastError: { code: error.code, message: error.message }, lastTestedAt: new Date() });
      res.json({ ok: false, model, error: error.toJSON(), provider: serializeProvider(row) });
    }
  } catch (error) {
    sendError(res, error, 'Failed to test AI provider');
  }
};

// GET /ai/providers/:providerId/models?refresh=true
const getProviderModels = async (req, res) => {
  try {
    const refresh = req.query.refresh === 'true' || req.query.refresh === '1';
    const row = await findOwnedProvider(req, { withSecret: refresh });
    const def = registry.getProvider(row.providerType);
    if (!refresh || !def.modelDiscovery) {
      return res.json({ models: row.models || [], fetchedAt: row.modelsFetchedAt, suggested: def.suggestedModels, discovery: def.modelDiscovery });
    }
    await rewrapIfNeeded(row);
    const discovered = await gateway.listModels(row.get({ plain: true }), { timeoutMs: 20000 });
    const models = mergeModels(row.models, discovered);
    await row.update({ models, modelsFetchedAt: new Date() });
    res.json({ models, fetchedAt: row.modelsFetchedAt, suggested: def.suggestedModels, discovery: true });
  } catch (error) {
    sendError(res, error, 'Failed to load models');
  }
};

module.exports = {
  getConfig,
  updateSettings,
  createProvider,
  updateProvider,
  deleteProvider,
  testProvider,
  getProviderModels,
  // exported for tests
  serializeProvider,
  parseProviderInput,
  mergeModels,
};
