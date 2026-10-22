const { AiError } = require('./errors');
const registry = require('./registry');

// AI privacy rules, enforced on the server so a modified app can't skip them.
//
// Consent: before text goes to a cloud provider, the user must have agreed
// for that provider and that kind of content:
//   - "drafts": what the user typed (writing assistant, draft translation);
//   - "conversation": messages from the chat, including other people's
//     (suggested replies, group memory, action items, message translation).
// Consent is tied to the provider's address: pointing the provider somewhere
// else asks again. Self-hosted providers need no consent (the user runs them).
//
// Context level: how much of a conversation AI may see at once.

const POLICY_VERSION = 1;
const SCOPES = ['drafts', 'conversation'];
const CONTEXT_LEVELS = {
  off: { replyMessages: 0, evidence: 0 },
  minimal: { replyMessages: 5, evidence: 20 },
  standard: { replyMessages: 15, evidence: 120 },
};

const hostOf = (provider) => {
  const def = registry.getProvider(provider.providerType);
  try {
    return new URL((def?.baseUrlEditable ? provider.baseUrl : null) || def?.defaultBaseUrl || '').host.toLowerCase();
  } catch {
    return '';
  }
};

const hasConsent = (settings, provider, scope) => {
  const entry = settings.consents?.[provider.id]?.[scope];
  return !!entry && entry.version === POLICY_VERSION && entry.host === hostOf(provider);
};

/** Throws CONSENT_REQUIRED unless the user agreed (or the provider is self-hosted). */
const requireConsent = (settings, provider, scope) => {
  if (!SCOPES.includes(scope)) throw new AiError('VALIDATION_ERROR', 'Unknown consent scope.');
  if (registry.deploymentOf(provider) !== 'cloud') return;
  if (hasConsent(settings, provider, scope)) return;
  throw new AiError('CONSENT_REQUIRED', scope === 'drafts'
    ? `Allow sending your drafts to ${provider.label} first.`
    : `Allow sending chat messages to ${provider.label} first.`, {
    status: 409,
    data: { providerId: provider.id, providerLabel: provider.label, providerType: provider.providerType, scope },
  });
};

const grant = (settings, provider, scope) => ({
  ...settings,
  consents: {
    ...(settings.consents || {}),
    [provider.id]: {
      ...((settings.consents || {})[provider.id] || {}),
      [scope]: { at: new Date().toISOString(), host: hostOf(provider), version: POLICY_VERSION },
    },
  },
});

/** Revoke one scope, all scopes for a provider, or everything. */
const revoke = (settings, providerId, scope) => {
  const consents = JSON.parse(JSON.stringify(settings.consents || {}));
  if (!providerId) return { ...settings, consents: {} };
  if (!scope) delete consents[providerId];
  else if (consents[providerId]) {
    delete consents[providerId][scope];
    if (!Object.keys(consents[providerId]).length) delete consents[providerId];
  }
  return { ...settings, consents };
};

const contextLimits = (settings) => CONTEXT_LEVELS[settings.contextLevel] || CONTEXT_LEVELS.standard;

/** Messages from a conversation may be used: returns the cap, or throws when the user turned it off. */
const conversationCap = (settings, kind) => {
  const cap = contextLimits(settings)[kind];
  if (!cap) {
    throw new AiError('CONTEXT_DISABLED', 'Conversation context is turned off in Settings > AI & Models > Privacy.', { status: 409 });
  }
  return cap;
};

module.exports = { POLICY_VERSION, SCOPES, CONTEXT_LEVELS, hostOf, hasConsent, requireConsent, grant, revoke, contextLimits, conversationCap };
