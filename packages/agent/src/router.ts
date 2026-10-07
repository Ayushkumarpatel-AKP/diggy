/**
 * The model router.
 *
 * Two roles — `'fast'` and `'strong'` — resolve to a `{ provider, model, apiKey }`
 * descriptor. The failover semantics are exactly the ones in
 * `apps/extension/src/brain.ts`:
 *
 *   - the active provider is tried first, then the other;
 *   - a 429/quota error marks a provider exhausted for **five minutes**
 *     ({@link EXHAUST_MS}), after which it is eligible again;
 *   - providers without a key are dropped from the chain;
 *   - if every provider is exhausted the active one is used as a last resort.
 *
 * The router returns plain data, not an `ai` model object, so `@diggy/agent`
 * stays dependency-free; the host turns the descriptor into a provider with
 * `createProvider({ name, apiKey, model })` from `@diggy/core`.
 */
import type { ProviderName } from './types';

export type ModelRole = 'fast' | 'strong';

/** How long an exhausted provider is skipped before it is tried again. */
export const EXHAUST_MS = 5 * 60 * 1000;

/** Best-effort default model ids, matching the providers in `docs/PROJECT.md`. */
export const DEFAULT_MODELS: Record<ModelRole, Record<ProviderName, string>> = {
  fast: { groq: 'openai/gpt-oss-20b', nvidia: 'openai/gpt-oss-20b' },
  strong: { groq: 'openai/gpt-oss-120b', nvidia: 'openai/gpt-oss-20b' },
};

export interface RouterKeys {
  groq?: string;
  nvidia?: string;
}

export interface ResolveModelConfig {
  /** The provider the user picked (matches `Settings.provider`). */
  provider: ProviderName;
  /** Per-role model ids. */
  roles?: { fast?: string; strong?: string };
  /** Per-provider api keys. */
  keys?: RouterKeys;
  /** A single fallback model id used when a role has none. */
  model?: string;
}

export interface ResolvedModel {
  role: ModelRole;
  provider: ProviderName;
  model: string;
  apiKey: string;
  /** True when the active provider was skipped in favour of the other. */
  switched: boolean;
  /** True when every configured provider is currently exhausted. */
  exhausted: boolean;
}

/** The api key configured for a provider, or `''`. */
export function keyFor(config: ResolveModelConfig, name: ProviderName): string {
  const keys = config?.keys ?? {};
  const value = name === 'groq' ? keys.groq : keys.nvidia;
  return typeof value === 'string' ? value.trim() : '';
}

/** Providers that have a key, active first, then the other — as in `brain.ts`. */
export function providerChain(config: ResolveModelConfig): ProviderName[] {
  const source = (config ?? {}) as ResolveModelConfig;
  const first: ProviderName = source.provider === 'nvidia' ? 'nvidia' : 'groq';
  const second: ProviderName = first === 'groq' ? 'nvidia' : 'groq';
  return [first, second].filter((name) => keyFor(source, name).length > 0);
}

/** Does this error look like a rate limit / quota / billing problem? */
export function isQuotaError(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
  return /rate limit|429|quota|exceeded|too many requests|tokens per minute|\btpm\b|billing|insufficient/.test(
    text,
  );
}

function activeProvider(config: ResolveModelConfig): ProviderName {
  return config?.provider === 'nvidia' ? 'nvidia' : 'groq';
}

function modelFor(role: ModelRole, provider: ProviderName, config: ResolveModelConfig): string {
  const roles = config?.roles ?? {};
  const roleModel = role === 'fast' ? roles.fast : roles.strong;
  if (typeof roleModel === 'string' && roleModel.trim().length > 0) return roleModel.trim();
  if (typeof config?.model === 'string' && config.model.trim().length > 0) return config.model.trim();
  return DEFAULT_MODELS[role][provider];
}

/**
 * A router with its own exhaustion memory. Use a fresh instance per test, or
 * the module-level {@link resolveModel} for the shared behaviour.
 */
export class ModelRouter {
  private exhaustedUntil: Partial<Record<ProviderName, number>> = {};
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = typeof now === 'function' ? now : () => Date.now();
  }

  isExhausted(name: ProviderName): boolean {
    const until = this.exhaustedUntil[name];
    return Boolean(until && until > this.now());
  }

  /** Mark a provider exhausted for {@link EXHAUST_MS} from `at` (default: now). */
  markExhausted(name: ProviderName, at: number = this.now()): void {
    this.exhaustedUntil[name] = (Number.isFinite(at) ? at : this.now()) + EXHAUST_MS;
  }

  reset(): void {
    this.exhaustedUntil = {};
  }

  resolveModel(role: ModelRole, config: ResolveModelConfig): ResolvedModel {
    const safeRole: ModelRole = role === 'strong' ? 'strong' : 'fast';
    const source = (config ?? {}) as ResolveModelConfig;
    const active = activeProvider(source);
    const chain = providerChain(source);
    const candidates = chain.length > 0 ? chain : [active];
    const ordered = [...candidates].sort(
      (a, b) => Number(this.isExhausted(a)) - Number(this.isExhausted(b)),
    );
    const chosen = ordered[0] ?? active;
    return {
      role: safeRole,
      provider: chosen,
      model: modelFor(safeRole, chosen, source),
      apiKey: keyFor(source, chosen),
      switched: chosen !== active,
      exhausted: ordered.every((name) => this.isExhausted(name)),
    };
  }
}

/** The shared router behind the free functions below. */
const sharedRouter = new ModelRouter();

/** Resolve a role to a concrete model using the shared exhaustion memory. */
export function resolveModel(role: ModelRole, config: ResolveModelConfig): ResolvedModel {
  return sharedRouter.resolveModel(role, config);
}

export function isExhausted(name: ProviderName): boolean {
  return sharedRouter.isExhausted(name);
}

export function markExhausted(name: ProviderName): void {
  sharedRouter.markExhausted(name);
}

/** Forget the exhaustion memory (e.g. after the user changes keys). */
export function resetProviderHealth(): void {
  sharedRouter.reset();
}
