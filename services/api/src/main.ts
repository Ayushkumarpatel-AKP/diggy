/**
 * CLI entry point for the Diggy connect-backend.
 *
 * Run with `pnpm --filter @diggy/api start` (which is `tsx src/main.ts`).
 * Prints the localhost URL the extension talks to, then stays up until
 * interrupted. Tokens are never logged.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getContext } from './config.js';
import { HOST, startServer } from './server.js';

export async function main(): Promise<void> {
  const ctx = getContext();
  const app = await startServer(ctx.config.port, { context: ctx });

  console.log('');
  console.log('  Diggy connect-backend is running');
  console.log(`  base url : ${ctx.config.publicUrl}`);
  console.log(`  health   : http://${HOST}:${ctx.config.port}/health`);
  console.log(`  database : ${ctx.config.dbPath}`);
  console.log(
    `  secrets  : token key ${ctx.config.tokenKeyGenerated ? 'generated' : 'from env'}, ` +
      `session secret ${ctx.config.sessionSecretGenerated ? 'generated' : 'from env'}`,
  );
  console.log('');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[api] received ${signal}, shutting down…`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error('[api] failed to start:', error);
    process.exit(1);
  });
}
