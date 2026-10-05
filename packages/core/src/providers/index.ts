/**
 * Provider registry for the Diggy brain.
 *
 * Both providers are plain OpenAI-compatible endpoints, so they are fully
 * interchangeable: only `baseURL` + `model` (+ api key) differ. The orchestrator
 * never needs to know which one is in use.
 */
import type { LanguageModelV1 } from 'ai';
import { createGroqModel, type GroqConfig } from './groq';
import { createNvidiaNimModel, type NvidiaNimConfig } from './nvidia-nim';

export type ProviderName = 'nvidia' | 'groq';

/** Configuration accepted by {@link createProvider}. */
export interface ProviderConfig {
  /** Which provider to build. When omitted it is resolved from the environment. */
  name?: ProviderName;
  /** Explicit api key; otherwise read from the provider's env var. */
  apiKey?: string;
  /** Override the API base URL (must stay OpenAI-compatible). */
  baseURL?: string;
  /** Override the model id. */
  model?: string;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Injectable fetch implementation (tests). */
  fetch?: typeof fetch;
}

type Env = Record<string, string | undefined>;

function readEnv(env?: Env): Env {
  if (env) return env;
  if (typeof process !== 'undefined' && process.env) {
    return process.env as Env;
  }
  return {};
}

/**
 * Resolve which provider to use when none is named.
 * Prefers **groq** when `GROQ_API_KEY` is set, otherwise **nvidia**.
 */
export function resolveProviderName(env?: Env): ProviderName {
  const source = readEnv(env);
  if (source.GROQ_API_KEY) return 'groq';
  return 'nvidia';
}

/** Build a provider model from an explicit config object. */
export function createProvider(config: ProviderConfig = {}): LanguageModelV1 {
  const name = config.name ?? resolveProviderName();
  if (name === 'groq') {
    const groqConfig: GroqConfig = {
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      model: config.model,
      headers: config.headers,
      fetch: config.fetch,
    };
    return createGroqModel(groqConfig);
  }
  const nimConfig: NvidiaNimConfig = {
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    model: config.model,
    headers: config.headers,
    fetch: config.fetch,
  };
  return createNvidiaNimModel(nimConfig);
}

/**
 * Factory used by the host.
 *
 * - `getProvider('groq')` / `getProvider('nvidia')` pick explicitly.
 * - `getProvider()` defaults from the environment, preferring Groq when
 *   `GROQ_API_KEY` is present, else NVIDIA NIM.
 */
export function getProvider(name?: ProviderName): LanguageModelV1 {
  return createProvider({ name: name ?? resolveProviderName() });
}

export * from './http';
export * from './groq';
export * from './nvidia-nim';
