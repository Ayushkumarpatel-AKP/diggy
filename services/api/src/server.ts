/**
 * The Diggy connect-backend HTTP server.
 *
 * Binds **127.0.0.1 only** — it is a local helper for the browser extension,
 * never a public service. `buildServer()` is separate from `startServer()` so
 * tests can drive it with `fastify.inject()` without opening a socket.
 *
 * Every request is filtered through the shared `@diggy/shared/service-auth`
 * guard: the `Host` must name loopback on this service's port, the `Origin`
 * (when present) must be the browser extension, and — except for `GET /health`
 * — a valid `x-diggy-token` must be supplied. POST bodies must be JSON. This
 * stops a hostile web page (DNS rebinding / cross-site fetch) from reaching the
 * local backend.
 */
import { evaluateRequest } from '@diggy/shared/service-auth';
import Fastify, { type FastifyInstance } from 'fastify';

import { getContext, type AppContext } from './config.js';
import { registerActionRoutes } from './routes/actions.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerPluginRoutes } from './routes/plugins.js';
import { registerPreviewRoutes } from './routes/preview.js';

/** Loopback host — never exposed on a public interface. */
export const HOST = '127.0.0.1';

export interface BuildServerOptions {
  /** Override the ambient context (tests pass an isolated `:memory:` context). */
  context?: AppContext;
  /** Expected per-install token. Defaults to `DIGGY_TOKEN` / `~/.diggy/token`. */
  token?: string;
  /** Port used for Host-header validation. Defaults to the configured port. */
  port?: number;
}

/** Build a Fastify instance with the service guard and every route registered. */
export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const ctx = options.context ?? getContext();
  const port = options.port ?? ctx.config.port;
  const app = Fastify({ logger: false });

  app.addHook('onRequest', async (request, reply) => {
    const result = evaluateRequest(
      { method: request.method, url: request.url, headers: request.headers },
      { port, ...(options.token !== undefined ? { token: options.token } : {}) },
    );
    if (!result.ok) {
      return reply.code(result.status).send(result.body);
    }
  });

  app.get('/health', async () => ({ status: 'ok', service: '@diggy/api', version: 1 }));

  registerAuthRoutes(app, ctx);
  registerPluginRoutes(app, ctx);
  registerActionRoutes(app, ctx);
  registerPreviewRoutes(app);

  return app;
}

/**
 * Start the server, binding **127.0.0.1 only**. Resolves once it is listening.
 */
export async function startServer(
  port?: number,
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const ctx = options.context ?? getContext();
  const resolvedPort = port ?? options.port ?? ctx.config.port;
  const app = buildServer({ ...options, context: ctx, port: resolvedPort });
  await app.listen({ port: resolvedPort, host: HOST });
  return app;
}
