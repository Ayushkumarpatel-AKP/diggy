/**
 * The Diggy connect-backend HTTP server.
 *
 * Binds **127.0.0.1 only** — it is a local helper for the browser extension,
 * never a public service. `buildServer()` is separate from `startServer()` so
 * tests can drive it with `fastify.inject()` without opening a socket.
 */
import cors from '@fastify/cors';
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
}

/** Allow the extension origins and localhost during development. */
function corsOrigin(
  origin: string | undefined,
  callback: (error: Error | null, allow: boolean) => void,
): void {
  if (!origin) {
    callback(null, true);
    return;
  }
  try {
    const url = new URL(origin);
    const allowed =
      url.protocol === 'chrome-extension:' ||
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]';
    callback(null, allowed);
  } catch {
    callback(null, false);
  }
}

/** Build a Fastify instance with CORS and every route registered. */
export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const ctx = options.context ?? getContext();
  const app = Fastify({ logger: false });

  void app.register(cors, { origin: corsOrigin, credentials: true });

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
  const app = buildServer({ context: ctx });
  await app.listen({ port: port ?? ctx.config.port, host: HOST });
  return app;
}
