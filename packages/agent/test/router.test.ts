import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_MODELS,
  EXHAUST_MS,
  ModelRouter,
  isExhausted,
  isQuotaError,
  keyFor,
  markExhausted,
  providerChain,
  resetProviderHealth,
  resolveModel,
  type ResolveModelConfig,
} from '../src/index';

const KEYS = { groq: 'groq-key', nvidia: 'nvidia-key' };

function config(overrides: Partial<ResolveModelConfig> = {}): ResolveModelConfig {
  return { provider: 'groq', keys: KEYS, roles: { fast: 'fast-model', strong: 'strong-model' }, ...overrides };
}

describe('ModelRouter.resolveModel', () => {
  it('returns the configured model for each role', () => {
    const router = new ModelRouter(() => 0);
    const fast = router.resolveModel('fast', config());
    const strong = router.resolveModel('strong', config());

    expect(fast.role).toBe('fast');
    expect(fast.model).toBe('fast-model');
    expect(fast.provider).toBe('groq');
    expect(fast.apiKey).toBe('groq-key');
    expect(fast.switched).toBe(false);

    expect(strong.role).toBe('strong');
    expect(strong.model).toBe('strong-model');
    expect(strong.provider).toBe('groq');
  });

  it('falls over to the other provider when one is exhausted, then recovers after five minutes', () => {
    let now = 0;
    const router = new ModelRouter(() => now);

    router.markExhausted('groq');
    const switched = router.resolveModel('fast', config());
    expect(switched.provider).toBe('nvidia');
    expect(switched.switched).toBe(true);
    expect(switched.apiKey).toBe('nvidia-key');
    expect(switched.model).toBe('fast-model'); // the role id is provider-agnostic

    now = EXHAUST_MS - 1_000; // still within the 5-minute window
    expect(router.resolveModel('fast', config()).provider).toBe('nvidia');

    now = EXHAUST_MS + 1_000; // window elapsed — groq is eligible again
    const recovered = router.resolveModel('fast', config());
    expect(recovered.provider).toBe('groq');
    expect(recovered.switched).toBe(false);
  });

  it('only uses providers that have a key', () => {
    const router = new ModelRouter(() => 0);
    const resolved = router.resolveModel('strong', {
      provider: 'groq',
      keys: { nvidia: 'only-nvidia' },
      roles: { strong: 's' },
    });
    expect(resolved.provider).toBe('nvidia');
    expect(resolved.apiKey).toBe('only-nvidia');
  });

  it('returns the active provider with an empty key when nothing is configured', () => {
    const router = new ModelRouter(() => 0);
    const resolved = router.resolveModel('fast', { provider: 'groq', keys: {} });
    expect(resolved.provider).toBe('groq');
    expect(resolved.apiKey).toBe('');
    expect(resolved.model).toBe(DEFAULT_MODELS.fast.groq); // documented default
  });

  it('uses documented default models when a role has none', () => {
    const router = new ModelRouter(() => 0);
    expect(router.resolveModel('fast', { provider: 'groq', keys: KEYS }).model).toBe(DEFAULT_MODELS.fast.groq);
    expect(router.resolveModel('strong', { provider: 'nvidia', keys: KEYS }).model).toBe(
      DEFAULT_MODELS.strong.nvidia,
    );
  });

  it('flags "everything exhausted" but still returns a provider', () => {
    const router = new ModelRouter(() => 0);
    router.markExhausted('groq');
    router.markExhausted('nvidia');
    const resolved = router.resolveModel('fast', config());
    expect(resolved.exhausted).toBe(true);
    expect(['groq', 'nvidia']).toContain(resolved.provider);
  });

  it('survives garbage configs', () => {
    const router = new ModelRouter(() => 0);
    expect(() => router.resolveModel('fast', undefined as unknown as ResolveModelConfig)).not.toThrow();
    expect(() => router.resolveModel('weird' as never, config())).not.toThrow();
    expect(router.resolveModel('weird' as never, config()).role).toBe('fast');
  });
});

describe('router helpers', () => {
  it('providerChain lists the active provider first, then the other', () => {
    expect(providerChain({ provider: 'groq', keys: KEYS })).toEqual(['groq', 'nvidia']);
    expect(providerChain({ provider: 'nvidia', keys: KEYS })).toEqual(['nvidia', 'groq']);
    expect(providerChain({ provider: 'groq', keys: { groq: 'g' } })).toEqual(['groq']);
    expect(providerChain({ provider: 'groq', keys: {} })).toEqual([]);
  });

  it('keyFor trims and tolerates non-strings', () => {
    expect(keyFor({ provider: 'groq', keys: { groq: '  spaced  ' } }, 'groq')).toBe('spaced');
    expect(keyFor({ provider: 'groq', keys: { groq: 42 as unknown as string } }, 'groq')).toBe('');
    expect(keyFor({ provider: 'groq' }, 'nvidia')).toBe('');
  });

  it('isQuotaError matches the brain.ts quota vocabulary', () => {
    expect(isQuotaError(new Error('Rate limit exceeded, 429'))).toBe(true);
    expect(isQuotaError('tokens per minute exceeded')).toBe(true);
    expect(isQuotaError(new Error('billing: insufficient credits'))).toBe(true);
    expect(isQuotaError(new Error('invalid api key'))).toBe(false);
    expect(isQuotaError('network timeout')).toBe(false);
  });
});

describe('shared router (free functions)', () => {
  beforeEach(() => resetProviderHealth());

  it('shares one exhaustion memory between resolveModel and the health helpers', () => {
    expect(isExhausted('groq')).toBe(false);
    markExhausted('groq');
    expect(isExhausted('groq')).toBe(true);

    const resolved = resolveModel('fast', config());
    expect(resolved.provider).toBe('nvidia');
    expect(resolved.switched).toBe(true);

    resetProviderHealth();
    expect(isExhausted('groq')).toBe(false);
    expect(resolveModel('fast', config()).provider).toBe('groq');
  });
});
