/**
 * SPIKE — NOT SHIPPED.
 *
 * Runnable proof. Run it from the repo root:
 *
 *     node --experimental-strip-types spikes/mcp/src/smoke.ts
 *   (or: pnpm --dir spikes/mcp spike)
 *
 * It drives the **real** `experimental_createMCPClient` from `ai@4.3.19`
 * against an **in-process** MCP server (no socket, no network) and then maps the
 * result onto Diggy's plugin shapes. Add `--live https://host/sse` (or set
 * `MCP_SPIKE_URL`) to also attempt a genuine remote SSE connection.
 */
import { ai, aiModulePath } from './ai.ts';
import { googleMcpServer } from './fake-server.ts';
import {
  closeMcp,
  connectRemoteMcp,
  mcpToolSummaries,
  mcpToolsAsAiSdkTools,
} from './remote-client.ts';
import {
  CURRENT_REGISTRY,
  galleryRowsFromMcpServer,
  mergeToolsets,
  parseMcpToolName,
  registryFromMcpTools,
} from './plugin-shim.ts';
import type { Tool } from 'ai';

const NOT_SHIPPED = 'MCP SPIKE — experimental, NOT shipped, nothing imports this file.';

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 68 - title.length))}`);
}

function check(label: string, condition: boolean): void {
  console.log(`  ${condition ? '✅' : '❌'} ${label}`);
  if (!condition) failures.push(label);
}

const failures: string[] = [];

/* ------------------------------------------------------------------ *
 * 1. Offline: the real MCP client against an in-process server
 * ------------------------------------------------------------------ */

async function offlineProof(): Promise<void> {
  section('1. Offline proof — real MCP client, in-process server');
  console.log(`  AI SDK loaded from: ${aiModulePath}`);

  const server = googleMcpServer();
  const client = await ai.experimental_createMCPClient({
    transport: server.transport,
    name: 'diggy-mcp-spike',
  });

  const listed = await mcpToolSummaries(client);
  check(`initialize + tools/list advertised ${listed.length} tools`, listed.length === 3);
  for (const tool of listed) console.log(`      • ${tool.name} — ${tool.description ?? ''}`);

  const tools = await mcpToolsAsAiSdkTools(client);
  const names = Object.keys(tools).sort();
  check('AI SDK toolset keys match the server tools', names.join(',') === 'google.calendar.create,google.calendar.list,google.gmail.list');

  const gmail = tools['google.gmail.list'];
  if (!gmail || typeof gmail.execute !== 'function') {
    check('google.gmail.list has an execute()', false);
  } else {
    const result = await gmail.execute(
      { query: 'is:unread newer_than:2d', max: 5 },
      { toolCallId: 'spike-1', messages: [] },
    );
    const text = JSON.stringify(result);
    console.log(`      google.gmail.list → ${text}`);
    check('tools/call round-trips through the MCP client', text.includes('Interview invite'));
  }

  console.log(`  JSON-RPC methods seen: ${server.methods.join(' → ')}`);
  check('handshake order is initialize → notifications/initialized → tools/list',
    server.methods[0] === 'initialize' &&
      server.methods[1] === 'notifications/initialized' &&
      server.methods.includes('tools/list'));

  await closeMcp(client);
}

/* ------------------------------------------------------------------ *
 * 2. Mapping onto Diggy's plugin shapes
 * ------------------------------------------------------------------ */

async function mappingProof(): Promise<void> {
  section('2. Deriving Diggy’s plugin registry + gallery rows from MCP');
  const server = googleMcpServer();
  const client = await ai.experimental_createMCPClient({ transport: server.transport });
  const tools = await mcpToolSummaries(client);

  for (const tool of tools) {
    console.log(`      ${tool.name} → provider/action ${JSON.stringify(parseMcpToolName(tool.name))}`);
  }
  const registry = registryFromMcpTools(tools);
  console.log(`      registry derived from tools: ${JSON.stringify(registry)}`);
  check('one provider (google) with three actions', registry.length === 1 && registry[0]?.actions.length === 3);

  const rows = galleryRowsFromMcpServer('diggy-google', tools);
  console.log(`      gallery rows (ApiPlugin shape): ${JSON.stringify(rows)}`);
  check('gallery rows carry the current ApiPlugin fields', rows[0]?.id === 'google' && rows[0]?.auth === 'oauth2');
  check('MCP cannot say “connected” — that stays false (the gap)', rows.every((row) => row.connected === false));

  const base: Record<string, Tool> = { readInbox: { description: 'built-in', parameters: { type: 'object', properties: {} } } as unknown as Tool };
  const merged = mergeToolsets(base, await mcpToolsAsAiSdkTools(client));
  check('MCP tools merge alongside built-ins', 'readInbox' in merged && 'google.gmail.list' in merged);
  let collided = false;
  try {
    mergeToolsets(base, { readInbox: {} as Tool });
  } catch {
    collided = true;
  }
  check('a shadowing tool name is rejected, not silently overwritten', collided);

  console.log(`      (the hand-written registry for comparison: ${CURRENT_REGISTRY.map((p) => p.id).join(', ')})`);
  await closeMcp(client);
}

/* ------------------------------------------------------------------ *
 * 3. Optional: a genuine remote SSE connection
 * ------------------------------------------------------------------ */

async function liveProbe(url: string | undefined): Promise<void> {
  section('3. Live remote MCP (SSE) — optional');
  if (!url) {
    console.log('  ⏭  skipped — pass --live <url> or set MCP_SPIKE_URL.');
    return;
  }
  console.log(`  connecting to ${url} …`);
  try {
    const client = await connectRemoteMcp({ url, name: 'diggy-mcp-spike' });
    const tools = await mcpToolSummaries(client);
    console.log(`  ✅ connected — ${tools.length} tools`);
    await closeMcp(client);
  } catch (error) {
    console.log(`  ⚠  could not connect (expected without network/a running server): ${String(error)}`);
  }
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log(`\n${NOT_SHIPPED}\n${'='.repeat(72)}`);
  await offlineProof();
  await mappingProof();

  const liveArgIndex = process.argv.indexOf('--live');
  const liveUrl =
    (liveArgIndex >= 0 ? process.argv[liveArgIndex + 1] : undefined) ??
    process.env.MCP_SPIKE_URL;
  await liveProbe(liveUrl);

  section('Result');
  if (failures.length > 0) {
    console.log(`  ❌ ${failures.length} check(s) failed:\n    - ${failures.join('\n    - ')}`);
    process.exitCode = 1;
  } else {
    console.log('  ✅ all offline checks passed.');
  }
  console.log('');
}

await main();
