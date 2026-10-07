/**
 * Test helpers for the API service.
 *
 * Every route except `GET /health` now requires the per-install
 * `x-diggy-token` header (and a loopback `Host` on the service port). The
 * `inject` wrapper below adds both so existing behavioural tests stay terse;
 * security tests call `app.inject` directly to exercise the failures.
 */
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';

/** Deterministic token injected via `DIGGY_TOKEN` for the whole test run. */
export const TEST_TOKEN = 'test-service-token-0123456789abcdef';

/** `DEFAULT_PORT` for `@diggy/api`. */
export const TEST_PORT = 17323;

/** Loopback Host header that satisfies Host validation. */
export const TEST_HOST = `127.0.0.1:${TEST_PORT}`;

// `buildServer` resolves the token from the environment, so make it stable.
process.env.DIGGY_TOKEN = TEST_TOKEN;

/** Standard headers every non-exempt request needs. */
export function serviceHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { host: TEST_HOST, 'x-diggy-token': TEST_TOKEN, ...extra };
}

/** `app.inject` with the service token + loopback Host pre-filled. */
export function inject(
  app: FastifyInstance,
  options: InjectOptions,
): Promise<LightMyRequestResponse> {
  const headers = { ...serviceHeaders(), ...(options.headers as Record<string, string> | undefined) };
  return app.inject({ ...options, headers });
}
