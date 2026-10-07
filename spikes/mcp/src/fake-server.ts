/**
 * SPIKE — NOT SHIPPED.
 *
 * An **in-process MCP server double**. It implements the same `MCPTransport`
 * interface the AI SDK's SSE transport implements (start / send / close +
 * onmessage), so the *real* `experimental_createMCPClient` can talk to it with
 * no socket and no network. This is what lets the spike prove something even
 * though we have no live MCP server to point at.
 *
 * It answers exactly the three JSON-RPC calls the AI SDK MCP client makes:
 *   initialize -> notifications/initialized -> tools/list -> tools/call
 * (see `ai@4.3.19` -> core/tool/mcp/mcp-client.ts).
 */
import type { MCPTransport } from 'ai';

/** One advertised tool, in MCP `tools/list` shape. */
export interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** What a tool returns when called (MCP `content` blocks). */
export interface McpToolCall {
  args: Record<string, unknown>;
  content: { type: 'text'; text: string }[];
}

export interface FakeMcpServerOptions {
  serverName: string;
  tools: McpToolSpec[];
  /** Handle a `tools/call` for `tool` with `args`. */
  onCall: (tool: string, args: Record<string, unknown>) => McpToolCall;
}

export interface FakeMcpServerHandle {
  transport: MCPTransport;
  /** Every JSON-RPC method the client sent, in order (a transcript to assert on). */
  readonly methods: string[];
}

type JsonRpcLike = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
};

/**
 * Build an `MCPTransport` backed by plain functions.
 *
 * The client's `onmessage` handler rejects anything that carries a `method`
 * ("Unsupported message type"), so this server only ever emits *responses*
 * (an `id` + `result`), never server->client requests or notifications.
 */
export function createInProcessMcpServer(options: FakeMcpServerOptions): FakeMcpServerHandle {
  const methods: string[] = [];
  let closed = false;

  const transport: MCPTransport = {
    async start(): Promise<void> {
      closed = false;
    },
    async close(): Promise<void> {
      closed = true;
      transport.onclose?.();
    },
    async send(message: unknown): Promise<void> {
      const msg = message as JsonRpcLike;
      const method = typeof msg.method === 'string' ? msg.method : '(response)';
      methods.push(method);

      // Respond asynchronously — the client registers its response handler
      // synchronously before `send` resolves, so a microtask is enough.
      const respond = (result: Record<string, unknown>, id: string | number): void => {
        if (closed) return;
        queueMicrotask(() => {
          transport.onmessage?.({ jsonrpc: '2.0', id, result } as never);
        });
      };

      if (typeof msg.id !== 'string' && typeof msg.id !== 'number') {
        // A notification (e.g. notifications/initialized) — nothing to answer.
        return;
      }
      const id = msg.id;

      switch (msg.method) {
        case 'initialize':
          respond(
            {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: options.serverName, version: '1.0.0' },
            },
            id,
          );
          return;
        case 'tools/list':
          respond({ tools: options.tools }, id);
          return;
        case 'tools/call': {
          const name = String(msg.params?.name ?? '');
          const args = (msg.params?.arguments as Record<string, unknown> | undefined) ?? {};
          const result = options.onCall(name, args);
          respond({ content: result.content, isError: false }, id);
          return;
        }
        default:
          // Unknown method → JSON-RPC error response.
          queueMicrotask(() => {
            transport.onmessage?.({
              jsonrpc: '2.0',
              id,
              error: { code: -32601, message: `Method not found: ${String(msg.method)}` },
            } as never);
          });
      }
    },
  };

  return { transport, methods };
}

/**
 * A believable "diggy-google" MCP server: the three actions the local backend
 * hand-writes today for Google (`google/gmail.list`, `google/calendar.list`,
 * `google/calendar.create` — see services/api/src/routes/actions.ts).
 */
export function googleMcpServer(): FakeMcpServerHandle {
  const tools: McpToolSpec[] = [
    {
      name: 'google.gmail.list',
      description: 'Read recent Gmail messages (sender, subject, snippet).',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Gmail search query' },
          max: { type: 'number', description: 'How many messages' },
        },
        required: [],
      },
    },
    {
      name: 'google.calendar.list',
      description: 'List upcoming events from the primary calendar.',
      inputSchema: {
        type: 'object',
        properties: { days: { type: 'number' } },
        required: [],
      },
    },
    {
      name: 'google.calendar.create',
      description: 'Create an event on the primary calendar.',
      inputSchema: {
        type: 'object',
        properties: { summary: { type: 'string' }, start: { type: 'string' } },
        required: ['summary', 'start'],
      },
    },
  ];

  return createInProcessMcpServer({
    serverName: 'diggy-google',
    tools,
    onCall(tool, args) {
      if (tool === 'google.gmail.list') {
        return {
          args,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                messages: [
                  { from: 'jobs@acme.test', subject: 'Interview invite', snippet: 'We would love to…' },
                ],
              }),
            },
          ],
        };
      }
      if (tool === 'google.calendar.list') {
        return { args, content: [{ type: 'text', text: JSON.stringify({ events: [] }) }] };
      }
      return { args, content: [{ type: 'text', text: JSON.stringify({ ok: true, tool }) }] };
    },
  });
}
