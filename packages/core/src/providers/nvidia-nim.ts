/**
 * NVIDIA NIM provider — OpenAI-compatible.
 *
 * NOTE: `@ai-sdk/openai-compatible` is not installed in this workspace, so we
 * use the built-in minimal OpenAI-compatible client from `./http` (see that file
 * for the documented limitations). The returned object is a real AI SDK
 * `LanguageModelV1`, so it drops straight into `streamText` / `generateText`.
 */
import type { LanguageModelV1 } from 'ai';
import {
  createOpenAICompatible,
  createOpenAICompatibleModel,
  type OpenAICompatibleProvider,
} from './http';

export const NVIDIA_NIM_BASE_URL = 'https://integrate.api.nvidia.com/v1';
/** Current NVIDIA default — available on NIM and supports tool calling. */
export const NVIDIA_NIM_DEFAULT_MODEL = 'openai/gpt-oss-20b';
export const NVIDIA_NIM_PROVIDER_NAME = 'nvidia-nim';

export interface NvidiaNimConfig {
  /** API key; falls back to `process.env.NVIDIA_API_KEY`. */
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
    return process.env.NVIDIA_API_KEY;
  }
  return undefined;
}

/** Create a ready-to-use NVIDIA NIM model. */
export function createNvidiaNimModel(config: NvidiaNimConfig = {}): LanguageModelV1 {
  return createOpenAICompatibleModel({
    provider: NVIDIA_NIM_PROVIDER_NAME,
    modelId: config.model ?? NVIDIA_NIM_DEFAULT_MODEL,
    baseURL: config.baseURL ?? NVIDIA_NIM_BASE_URL,
    apiKey: resolveApiKey(config.apiKey),
    headers: config.headers,
    fetch: config.fetch,
  });
}

/** Alias matching the `nvidiaNim()` naming used elsewhere. */
export const nvidiaNim = createNvidiaNimModel;

/** Provider-style factory: `provider(modelId)` -> model. */
export function createNvidiaNimProvider(config: NvidiaNimConfig = {}): OpenAICompatibleProvider {
  return createOpenAICompatible({
    name: NVIDIA_NIM_PROVIDER_NAME,
    baseURL: config.baseURL ?? NVIDIA_NIM_BASE_URL,
    apiKey: resolveApiKey(config.apiKey),
    headers: config.headers,
    fetch: config.fetch,
  });
}
