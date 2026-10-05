/**
 * CLI entry point for the Diggy bridge.
 *
 * Run it with `pnpm --filter @diggy/bridge start` (which is `tsx src/main.ts`).
 * It prints the token and URLs the browser extension needs, then stays up until
 * interrupted.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBridgeServer } from './server.js';

export async function main(): Promise<void> {
  const server = await createBridgeServer();

  console.log('');
  console.log('  Diggy bridge is running');
  console.log(`  websocket : ${server.url}`);
  console.log(`  health    : http://127.0.0.1:${server.port}/health`);
  console.log(`  crawler   : ${server.crawlerUrl}`);
  console.log(
    `  token     : ${server.token}${
      server.tokenGenerated ? '  (generated — set DIGGY_BRIDGE_TOKEN to pin one)' : ''
    }`,
  );
  console.log('');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[bridge] received ${signal}, shutting down…`);
    await server.close();
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
  main().catch((error) => {
    console.error('[bridge] failed to start:', error);
    process.exit(1);
  });
}
