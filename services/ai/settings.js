const { AiError } = require('./errors');
const { isValidModelId } = require('./registry');

// AI features that can each use their own provider and model. Stages 2-5 of
// the AI rollout plug into these keys; nothing here runs a feature yet.
const FEATURES = [
  { key: 'assistant', label: 'Message assistant', description: 'Write, rewrite, shorten and fix drafts.' },
  { key: 'replies', label: 'Reply suggestions', description: 'Suggest replies from recent messages.' },
  { key: 'memory', label: 'Group memory & search', description: 'Answer questions about past messages.' },
  { key: 'actions', label: 'Action cards', description: 'Turn conversations into tasks, polls and events.' },
  { key: 'translation', label: 'Language bridge', description: 'Translate messages and drafts.' },
  { key: 'games', label: 'Game creator', description: 'Turn an idea into a game to play in a chat.' },
];
const FEATURE_KEYS = FEATURES.map(f => f.key);

const LIMIT_RULES = {
  dailyRequestLimit: { min: 1, max: 100000, integer: true },
  monthlyTokenLimit: { min: 1000, max: 1000000000, integer: true },
  monthlyCostWarningUsd: { min: 0.01, max: 100000, integer: false },
};

const defaultSettings = () => ({
  enabled: false,
  defaultProviderId: null,
  defaultModel: null,
  features: Object.fromEntries(FEATURE_KEYS.map(k => [k, { enabled: true, providerId: null, model: null }])),
  limits: { dailyRequestLimit: null, monthlyTokenLimit: null, monthlyCostWarningUsd: null },
  preferredLanguage: null,
  // How much of a conversation AI may see (services/ai/privacy CONTEXT_LEVELS)
  contextLevel: 'standard',
  // { [providerId]: { drafts?: {at, host, version}, conversation?: {...} } }
  consents: {},
});

/** Stored row (or nothing) -> complete settings object with every key present. */
const normalize = (row) => {
  const base = defaultSettings();
  if (!row) return base;
  const features = row.features || {};
  return {
    enabled: !!row.enabled,
    defaultProviderId: row.defaultProviderId || null,
    defaultModel: row.defaultModel || null,
    features: Object.fromEntries(FEATURE_KEYS.map(k => [k, {
      enabled: features[k]?.enabled !== false,
      providerId: features[k]?.providerId || null,
      model: features[k]?.model || null,
    }])),
    limits: { ...base.limits, ...(row.limits || {}) },
    preferredLanguage: row.preferredLanguage || null,
    contextLevel: ['off', 'minimal', 'standard'].includes(row.contextLevel) ? row.contextLevel : 'standard',
    consents: row.consents && typeof row.consents === 'object' ? row.consents : {},
  };
};

const invalid = (message) => new AiError('VALIDATION_ERROR', message);

const checkModel = (value, field) => {
  if (value === null || value === '') return null;
  if (!isValidModelId(value)) throw invalid(`${field} is not a valid model name.`);
  return value;
};

/**
 * Merge a partial update into the current settings. `providerIds` is the set
 * of the user's own provider configuration ids, so nobody can point a feature
 * at another account's provider.
 */
const applyUpdate = (current, patch, providerIds) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('Settings must be an object.');
  const next = JSON.parse(JSON.stringify(current));
  const checkProvider = (value, field) => {
    if (value === null || value === '') return null;
    if (typeof value !== 'string' || !providerIds.has(value)) throw invalid(`${field} is not one of your providers.`);
    return value;
  };

  if ('enabled' in patch) {
    if (typeof patch.enabled !== 'boolean') throw invalid('enabled must be true or false.');
    next.enabled = patch.enabled;
  }
  if ('defaultProviderId' in patch) {
    next.defaultProviderId = checkProvider(patch.defaultProviderId, 'Default provider');
    // A model belongs to its provider: switching provider forgets the old model
    if (next.defaultProviderId !== current.defaultProviderId && !('defaultModel' in patch)) next.defaultModel = null;
  }
  if ('defaultModel' in patch) next.defaultModel = checkModel(patch.defaultModel, 'Default model');

  if ('features' in patch) {
    const features = patch.features;
    if (!features || typeof features !== 'object' || Array.isArray(features)) throw invalid('features must be an object.');
    for (const [key, value] of Object.entries(features)) {
      if (!FEATURE_KEYS.includes(key)) throw invalid(`Unknown AI feature: ${key}.`);
      if (!value || typeof value !== 'object') throw invalid(`Settings for ${key} must be an object.`);
      const target = next.features[key];
      if ('enabled' in value) {
        if (typeof value.enabled !== 'boolean') throw invalid(`${key}.enabled must be true or false.`);
        target.enabled = value.enabled;
      }
      if ('providerId' in value) {
        const providerId = checkProvider(value.providerId, `Provider for ${key}`);
        if (providerId !== target.providerId && !('model' in value)) target.model = null;
        target.providerId = providerId;
      }
      if ('model' in value) target.model = checkModel(value.model, `Model for ${key}`);
    }
  }

  if ('contextLevel' in patch) {
    if (!['off', 'minimal', 'standard'].includes(patch.contextLevel)) throw invalid('contextLevel must be off, minimal or standard.');
    next.contextLevel = patch.contextLevel;
  }

  // Consents change only through POST /ai/consent and /ai/consent/revoke
  if ('consents' in patch) throw invalid('Use the consent endpoints to change permissions.');

  if ('preferredLanguage' in patch) {
    const { LANGUAGES } = require('./assistant');
    const value = patch.preferredLanguage;
    if (value !== null && value !== '' && !LANGUAGES.includes(value)) throw invalid('Choose a supported language.');
    next.preferredLanguage = value || null;
  }

  if ('limits' in patch) {
    const limits = patch.limits;
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw invalid('limits must be an object.');
    for (const [key, value] of Object.entries(limits)) {
      const rule = LIMIT_RULES[key];
      if (!rule) throw invalid(`Unknown limit: ${key}.`);
      if (value === null || value === '') {
        next.limits[key] = null;
        continue;
      }
      const number = Number(value);
      if (!Number.isFinite(number) || number < rule.min || number > rule.max || (rule.integer && !Number.isInteger(number))) {
        throw invalid(`${key} must be ${rule.integer ? 'a whole number' : 'a number'} between ${rule.min} and ${rule.max}.`);
      }
      next.limits[key] = number;
    }
  }

  return next;
};

/** Forget every reference to a deleted provider; features then report NO_PROVIDER instead of switching. */
const withoutProvider = (settings, providerId) => {
  const next = JSON.parse(JSON.stringify(settings));
  if (next.defaultProviderId === providerId) {
    next.defaultProviderId = null;
    next.defaultModel = null;
  }
  if (next.consents) delete next.consents[providerId];
  for (const key of FEATURE_KEYS) {
    if (next.features[key].providerId === providerId) {
      next.features[key].providerId = null;
      next.features[key].model = null;
    }
  }
  return next;
};

module.exports = { FEATURES, FEATURE_KEYS, defaultSettings, normalize, applyUpdate, withoutProvider };
