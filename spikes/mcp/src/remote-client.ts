/**
 * SPIKE — NOT SHIPPED.
 *
 * The headline of the spike: talk to a **remote** MCP server over SSE with the
 * Vercel AI SDK's built-in MCP client (`experimental_createMCPClient`), and hand
 * its tools to the model as ordinary AI SDK tools. This is the whole integration
 * surface — no hand-written per-provider connector, no `/oauth/:provider/start`
 * route, no `/actions/:provider/:action` switch.
 *
 * Works on the dependency that is already in the tree:
 *   - `ai@4.3.19` exports `experimental_createMCPClient` and a `type: 'sse'`
 *     transport (`{ url, headers? }`) — core/tool/mcp/mcp-sse-transport.ts.
 *   - Its stdio sibling lives at the `ai/mcp-stdio` subpath.
 *   - `@modelcontextprotocol/sdk` is **not** installed and is **not** needed
 *     for the SSE transport.
 */
import { ai, type McpClient } from './ai.ts';
import type { Tool } from 'ai';

export interface RemoteMcpOptions {
  /** e.g. `https://mcp.example.com/sse`. */
  url: string;
  /** Static auth headers (an API key, or a Bearer token you already hold). */
  headers?: Record<string, string>;
  /** Client name reported in the MCP `initialize` handshake. */
  name?: string;
  /** Called when the transport reports an error the client did not expect. */
  onError?: (error: unknown) => void;
}

/** Open a remote MCP session. Resolves once the `initialize` handshake is done. */
export async function connectRemoteMcp(options: RemoteMcpOptions): Promise<McpClient> {
  return ai.experimental_createMCPClient({
    transport: {
      type: 'sse',
      url: options.url,
      ...(options.headers ? { headers: options.headers } : {}),
    },
    name: options.name ?? 'diggy-mcp-spike',
    onUncaughtError: (error) => options.onError?.(error),
  });
}

/**
 * The server's tools as `{ name, description }`.
 *
 * NOTE (a real finding, see docs/MCP_SPIKE.md): in `ai@4.3.19` the client's
 * `listTools()` and `callTool()` methods are **private** — `tools()` is the only
 * public discovery surface, and calling a tool goes through the returned tool's
 * own `execute()`. This helper and the smoke test use only that public surface.
 */
export async function mcpToolSummaries(
  client: McpClient,
): Promise<{ name: string; description?: string }[]> {
  const tools = await client.tools();
  return Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.description,
  }));
}

/**
 * The tools the AI SDK builds from the server, ready to merge into the model's
 * toolset. Each entry is a normal `Tool`, so adding a whole provider is one
 * spread — the model can call `google.gmail.list` exactly like `readInbox`.
 */
export async function mcpToolsAsAiSdkTools(client: McpClient): Promise<Record<string, Tool>> {
  // `client.tools()` is a `Record<string, Tool>`; erasing the tool-schema
  // generics keeps this file free of AI-SDK type parameters.
  const tools = await client.tools();
  return tools as unknown as Record<string, Tool>;
}

/** Close the session (the transport's `close()`). */
export async function closeMcp(client: McpClient): Promise<void> {
  await client.close();
}
