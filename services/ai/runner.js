const { Op, fn, col } = require('sequelize');
const { AiProviderConfig, AiUserSettings, AiUsageEvent } = require('../../models');
const { AiError, redact } = require('./errors');
const aiSettings = require('./settings');
const gateway = require('./gateway');
const registry = require('./registry');

// Runs one AI feature request for a user: picks the configured provider and
// model (no fallback), enforces the user's limits, calls the provider and
// records usage (counts and tokens only, never content).

const startOfDayUtc = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const startOfMonthUtc = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** Requests today and tokens this month (UTC). */
const usageSummary = async (userId, now = new Date()) => {
  const [requestsToday, tokens] = await Promise.all([
    AiUsageEvent.count({ where: { userId, createdAt: { [Op.gte]: startOfDayUtc(now) } } }),
    AiUsageEvent.findOne({
      where: { userId, createdAt: { [Op.gte]: startOfMonthUtc(now) } },
      attributes: [
        [fn('COALESCE', fn('SUM', col('inputTokens')), 0), 'input'],
        [fn('COALESCE', fn('SUM', col('outputTokens')), 0), 'output'],
        [fn('COUNT', col('id')), 'requests'],
      ],
      raw: true,
    }),
  ]);
  return {
    requestsToday,
    requestsThisMonth: Number(tokens?.requests || 0),
    tokensThisMonth: Number(tokens?.input || 0) + Number(tokens?.output || 0),
  };
};

/** Throws LIMIT_REACHED when a configured limit is used up. Pure. */
const checkLimits = (limits, usage) => {
  if (limits.dailyRequestLimit && usage.requestsToday >= limits.dailyRequestLimit) {
    throw new AiError('LIMIT_REACHED', `You have used today's ${limits.dailyRequestLimit} AI requests. The limit resets at midnight UTC, or you can raise it in Settings > AI & Models.`, { status: 429 });
  }
  if (limits.monthlyTokenLimit && usage.tokensThisMonth >= limits.monthlyTokenLimit) {
    throw new AiError('LIMIT_REACHED', `You have used this month's ${limits.monthlyTokenLimit.toLocaleString('en-US')} AI tokens. Raise the limit in Settings > AI & Models.`, { status: 429 });
  }
};

// Failures where the provider was never reached don't count as usage
const NOT_SENT = new Set(['CANCELLED', 'MISSING_CREDENTIALS', 'VAULT_NOT_CONFIGURED', 'VAULT_DECRYPT_FAILED', 'INVALID_MODEL', 'UNSUPPORTED_CAPABILITY', 'BLOCKED_ENDPOINT', 'INSECURE_ENDPOINT', 'INVALID_ENDPOINT']);

const record = (values) => AiUsageEvent.create(values).catch((error) => {
  console.error('[AI] usage record failed:', error?.name);
});

/**
 * Resolve, check and run. `build(capabilities)` returns the completion
 * request, so callers can ask for JSON only when the model supports it.
 */
const runFeature = async ({ userId, feature, action = null, build, signal }) => {
  const [settingsRow, rows] = await Promise.all([
    AiUserSettings.findByPk(userId),
    AiProviderConfig.scope('withSecret').findAll({ where: { userId } }),
  ]);
  const settings = aiSettings.normalize(settingsRow);
  const providers = rows.map(r => r.get({ plain: true }));
  const { provider, model } = gateway.resolveTarget(settings, providers, feature);

  checkLimits(settings.limits, await usageSummary(userId));

  const capabilities = registry.effectiveCapabilities(provider, model);
  const request = build(capabilities);
  const started = Date.now();
  const base = { userId, feature, action, providerId: provider.id, providerType: provider.providerType, model };
  try {
    const result = await gateway.completeWith(provider, model, { ...request, signal });
    record({
      ...base,
      status: 'ok',
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      latencyMs: Date.now() - started,
    });
    return {
      result,
      target: {
        providerId: provider.id,
        providerLabel: provider.label,
        providerType: provider.providerType,
        deployment: registry.deploymentOf(provider),
        model,
      },
    };
  } catch (error) {
    if (error instanceof AiError && !NOT_SENT.has(error.code)) {
      record({ ...base, status: 'error', errorCode: error.code, latencyMs: Date.now() - started });
    }
    if (!(error instanceof AiError)) console.error('[AI] provider call failed:', error?.name, redact(error?.message || ''));
    throw error;
  }
};

module.exports = { runFeature, usageSummary, checkLimits, startOfDayUtc, startOfMonthUtc };
