/**
 * Groq provider — OpenAI-compatible.
 *
 * NOTE: `@ai-sdk/openai-compatible` is not installed in this workspace, so we
 * use the built-in minimal OpenAI-compatible client from `./http` (see that file
 * for the documented limitations). The returned object is a real AI SDK
 * `LanguageModelV1`. Switching from NIM to Groq is only a change of
 * `baseURL` + `model` + api key.
 */
import type { LanguageModelV1 } from 'ai';
import {
  createOpenAICompatible,
  createOpenAICompatibleModel,
  type OpenAICompatibleProvider,
} from './http';

export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
/** Current Groq default — a strong, tool-calling-capable production model. */
export const GROQ_DEFAULT_MODEL = 'openai/gpt-oss-120b';
export const GROQ_PROVIDER_NAME = 'groq';

export interface GroqConfig {
  /** API key; falls back to `process.env.GROQ_API_KEY`. */
  apiKey?: string;
  /** Override the API base URL. */
  baseURL?: string;
  /** Override the model id. */
  model?: string;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Injectable fetch (tests). */
  fetch?: typeof fetch;
}

function resolveApiKey(explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (typeof process !== 'undefined' && process.env) {
    return process.env.GROQ_API_KEY;
  }
  return undefined;
}

/** Create a ready-to-use Groq model. */
export function createGroqModel(config: GroqConfig = {}): LanguageModelV1 {
  return createOpenAICompatibleModel({
    provider: GROQ_PROVIDER_NAME,
    modelId: config.model ?? GROQ_DEFAULT_MODEL,
    baseURL: config.baseURL ?? GROQ_BASE_URL,
    apiKey: resolveApiKey(config.apiKey),
    headers: config.headers,
    fetch: config.fetch,
  });
}

/** Alias matching the `groq()` naming used elsewhere. */
export const groq = createGroqModel;

/** Provider-style factory: `provider(modelId)` -> model. */
export function createGroqProvider(config: GroqConfig = {}): OpenAICompatibleProvider {
  return createOpenAICompatible({
    name: GROQ_PROVIDER_NAME,
    baseURL: config.baseURL ?? GROQ_BASE_URL,
    apiKey: resolveApiKey(config.apiKey),
    headers: config.headers,
    fetch: config.fetch,
  });
}
