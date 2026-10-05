import type { FetchLike } from './types.js';

/** Return a trimmed non-empty string, or `undefined` for anything else. */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Coerce an unknown value to a plain record (empty object for non-records). */
export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Promise-based sleep used by polling loops. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/** Human-readable message for an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve a response body as JSON, throwing a clear, provider-labelled error
 * when the request failed or the body is not valid JSON.
 */
export async function readJson<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    const detail = text.trim() ? ` Response: ${text.trim().slice(0, 300)}` : '';
    throw new Error(`${label} failed with HTTP ${response.status}.${detail}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} returned a non-JSON response.`);
  }
}

/** Perform a fetch, wrapping transport failures with a clear provider label. */
export async function callFetch(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    throw new Error(`${label} request to ${url} failed: ${errorMessage(error)}`);
  }
}

/** Parse a JSON string, returning `undefined` instead of throwing. */
export function tryParseJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
