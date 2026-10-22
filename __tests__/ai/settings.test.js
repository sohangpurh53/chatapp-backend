const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const settings = require('../../services/ai/settings');
const { resolveTarget } = require('../../services/ai/gateway');
const registry = require('../../services/ai/registry');

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const owned = new Set([P1, P2]);

const providers = [
  { id: P1, providerType: 'openai', enabled: true, defaultModel: 'gpt-4.1-mini' },
  { id: P2, providerType: 'ollama', enabled: true, defaultModel: 'llama3.2' },
];

describe('settings validation', () => {
  test('defaults are off with every feature present', () => {
    const s = settings.normalize(null);
    assert.equal(s.enabled, false);
    assert.deepEqual(Object.keys(s.features), settings.FEATURE_KEYS);
  });

  test('applies partial updates', () => {
    const next = settings.applyUpdate(settings.defaultSettings(), {
      enabled: true,
      defaultProviderId: P1,
      defaultModel: 'gpt-4.1',
      features: { translation: { providerId: P2, model: 'qwen2.5' }, memory: { enabled: false } },
      limits: { dailyRequestLimit: 200, monthlyCostWarningUsd: 5.5 },
    }, owned);
    assert.equal(next.enabled, true);
    assert.equal(next.features.translation.providerId, P2);
    assert.equal(next.features.memory.enabled, false);
    assert.equal(next.limits.dailyRequestLimit, 200);
    assert.equal(next.limits.monthlyTokenLimit, null);
  });

  test('refuses providers that belong to someone else', () => {
    assert.throws(
      () => settings.applyUpdate(settings.defaultSettings(), { defaultProviderId: '33333333-3333-4333-8333-333333333333' }, owned),
      { code: 'VALIDATION_ERROR' },
    );
    assert.throws(
      () => settings.applyUpdate(settings.defaultSettings(), { features: { assistant: { providerId: 'nope' } } }, owned),
      { code: 'VALIDATION_ERROR' },
    );
  });

  test('refuses unknown keys, bad models and out-of-range limits', () => {
    const base = settings.defaultSettings();
    assert.throws(() => settings.applyUpdate(base, { features: { hacking: {} } }, owned), { code: 'VALIDATION_ERROR' });
    assert.throws(() => settings.applyUpdate(base, { defaultModel: '../../etc' }, owned), { code: 'VALIDATION_ERROR' });
    assert.throws(() => settings.applyUpdate(base, { limits: { dailyRequestLimit: -1 } }, owned), { code: 'VALIDATION_ERROR' });
    assert.throws(() => settings.applyUpdate(base, { limits: { dailyRequestLimit: 1.5 } }, owned), { code: 'VALIDATION_ERROR' });
    assert.throws(() => settings.applyUpdate(base, { limits: { surprise: 1 } }, owned), { code: 'VALIDATION_ERROR' });
    assert.throws(() => settings.applyUpdate(base, { enabled: 'yes' }, owned), { code: 'VALIDATION_ERROR' });
  });

  test('changing a provider forgets the model that belonged to the old one', () => {
    const first = settings.applyUpdate(settings.defaultSettings(), { defaultProviderId: P1, defaultModel: 'gpt-4.1' }, owned);
    const second = settings.applyUpdate(first, { defaultProviderId: P2 }, owned);
    assert.equal(second.defaultModel, null);
  });

  test('removing a provider clears every reference to it', () => {
    const s = settings.applyUpdate(settings.defaultSettings(), {
      defaultProviderId: P1, defaultModel: 'gpt-4.1', features: { replies: { providerId: P1, model: 'x' } },
    }, owned);
    const cleared = settings.withoutProvider(s, P1);
    assert.equal(cleared.defaultProviderId, null);
    assert.equal(cleared.features.replies.providerId, null);
    assert.equal(cleared.features.replies.model, null);
  });
});

describe('feature resolution (no silent fallback)', () => {
  const enabled = (patch = {}) => settings.applyUpdate(settings.defaultSettings(), { enabled: true, defaultProviderId: P1, ...patch }, owned);

  test('AI off means no provider is used at all', () => {
    assert.throws(() => resolveTarget(settings.defaultSettings(), providers, 'assistant'), { code: 'AI_DISABLED' });
  });

  test('uses the default provider and its model', () => {
    const target = resolveTarget(enabled({ defaultModel: 'gpt-4.1' }), providers, 'assistant');
    assert.equal(target.provider.id, P1);
    assert.equal(target.model, 'gpt-4.1');
  });

  test('falls back to the provider default model, never another provider', () => {
    const target = resolveTarget(enabled(), providers, 'assistant');
    assert.equal(target.model, 'gpt-4.1-mini');
  });

  test('a per-feature provider wins', () => {
    const target = resolveTarget(enabled({ features: { translation: { providerId: P2 } } }), providers, 'translation');
    assert.equal(target.provider.id, P2);
    assert.equal(target.model, 'llama3.2');
    assert.equal(target.source, 'feature');
  });

  test('a disabled provider stops the feature instead of switching to the default', () => {
    const s = enabled({ features: { translation: { providerId: P2 } } });
    const withDisabled = providers.map(p => (p.id === P2 ? { ...p, enabled: false } : p));
    assert.throws(() => resolveTarget(s, withDisabled, 'translation'), { code: 'PROVIDER_DISABLED' });
  });

  test('a missing provider stops the feature', () => {
    assert.throws(() => resolveTarget(enabled(), [providers[1]], 'assistant'), { code: 'PROVIDER_NOT_FOUND' });
  });

  test('a disabled feature does not run', () => {
    assert.throws(() => resolveTarget(enabled({ features: { memory: { enabled: false } } }), providers, 'memory'), { code: 'FEATURE_DISABLED' });
  });

  test('no default provider and no model are reported clearly', () => {
    const noDefault = settings.applyUpdate(settings.defaultSettings(), { enabled: true }, owned);
    assert.throws(() => resolveTarget(noDefault, providers, 'assistant'), { code: 'NO_PROVIDER' });
    const noModel = [{ ...providers[0], defaultModel: null }];
    assert.throws(() => resolveTarget(enabled(), noModel, 'assistant'), { code: 'MODEL_REQUIRED' });
  });
});

describe('registry', () => {
  test('capabilities: defaults, then discovered, then user overrides', () => {
    const config = {
      providerType: 'ollama',
      defaultModel: 'llava',
      models: [{ id: 'llava', capabilities: { multimodal: true, toolCalling: false } }],
      capabilityOverrides: { toolCalling: true },
    };
    const caps = registry.effectiveCapabilities(config);
    assert.equal(caps.multimodal, true);
    assert.equal(caps.toolCalling, true);
    assert.equal(registry.effectiveCapabilities({ providerType: 'custom' }).structuredOutput, false);
  });

  test('deployment type', () => {
    assert.equal(registry.deploymentOf({ providerType: 'openai' }), 'cloud');
    assert.equal(registry.deploymentOf({ providerType: 'ollama', baseUrl: 'http://192.168.1.4:11434' }), 'self_hosted');
    assert.equal(registry.deploymentOf({ providerType: 'ollama', baseUrl: 'https://ollama.com' }), 'cloud');
    assert.equal(registry.deploymentOf({ providerType: 'ollama' }), 'cloud', 'Ollama Cloud is the default');
    assert.equal(registry.requiresApiKey('ollama', 'https://ollama.com'), true);
    assert.equal(registry.requiresApiKey('ollama', 'http://10.0.0.5:11434'), false);
    assert.equal(registry.requiresApiKey('groq'), true);
    assert.equal(registry.deploymentOf({ providerType: 'custom', baseUrl: 'https://llm.example.com/v1' }), 'cloud');
    assert.equal(registry.deploymentOf({ providerType: 'custom', baseUrl: 'https://llm.example.com/v1', deploymentType: 'self_hosted' }), 'self_hosted');
    assert.equal(registry.deploymentOf({ providerType: 'custom', baseUrl: 'http://10.0.0.5:8000/v1' }), 'self_hosted');
  });

  test('model ids', () => {
    for (const ok of ['gpt-4.1-mini', 'llama3.2:latest', 'models/gemini-2.5-flash', 'meta-llama/Llama-3.3-70B', 'org/model@v1']) {
      assert.equal(registry.isValidModelId(ok), true, ok);
    }
    for (const bad of ['', '../x', 'a b', 'x?y', 'a//b', '-lead', 'x'.repeat(201), null]) {
      assert.equal(registry.isValidModelId(bad), false, String(bad));
    }
  });
});
