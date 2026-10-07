# MCP spike — ⛔ NOT SHIPPED

> **This directory is a spike.** It is not a workspace package, nothing in
> `apps/`, `packages/` or `services/` imports it, and Turborepo never builds,
> tests or typechecks it (it is absent from `pnpm-workspace.yaml`, and
> `turbo.json` only fans out over workspace packages). It exists to answer one
> question with running code, not to ship.

## The question

Diggy connects to third-party services through **hand-written plugin
connectors**:

- a static registry — `services/api/src/providers.ts` (`PROVIDERS`),
- a `POST /actions/:provider/:action` switch — `services/api/src/routes/actions.ts`,
- a browser-side gallery — `apps/extension/entrypoints/sidepanel/PluginsPanel.tsx`
  driven by `GET /plugins`.

Each new provider means new code in all three places. **Could a remote
[Model Context Protocol](https://modelcontextprotocol.io) server replace that**,
so the backend just proxies MCP tools and the registry becomes data the server
advertises?

## The short answer

**The integration is trivial; the hard parts are not the integration.** The
already-installed Vercel AI SDK can open a remote MCP session and turn its tools
into model tools in ~30 lines. What MCP does *not* solve for Diggy is token
custody, per-user consent/account labels, and Google's restricted-scope
verification — the things the local backend exists for. See
[`../../docs/MCP_SPIKE.md`](../../docs/MCP_SPIKE.md) for the full write-up and the
recommendation.

## Dependency status (no install, no new package)

The spike uses **only what is already in the tree**:

| Thing | Where | Status |
|---|---|---|
| `experimental_createMCPClient` + `type: 'sse'` transport | `ai@4.3.19` (`@diggy/core`'s dependency) | ✅ present |
| `ai/mcp-stdio` subpath (stdio transport) | same package | ✅ present |
| `@modelcontextprotocol/sdk` | — | ❌ **not installed**, and **not needed** for the SSE transport |

`src/ai.ts` loads that installed copy at runtime via `createRequire` anchored at
`packages/core/package.json`, and `tsconfig.json` maps the bare `"ai"` specifier
to the same copy for the type checker. **No dependency was added.**

## Run it

```bash
# from the repo root
node --experimental-strip-types spikes/mcp/src/smoke.ts

# or
pnpm --dir spikes/mcp spike
```

Type-check the spike against the real AI SDK typings (optional):

```bash
node node_modules/typescript/bin/tsc -p spikes/mcp/tsconfig.json
```

Optional live remote connection (needs a real MCP SSE server + network):

```bash
node --experimental-strip-types spikes/mcp/src/smoke.ts --live https://host/sse
# or: MCP_SPIKE_URL=https://host/sse node --experimental-strip-types spikes/mcp/src/smoke.ts
```

## What it proves (offline, with the real MCP client)

`smoke.ts` drives the **genuine** `experimental_createMCPClient` against an
in-process MCP server (`src/fake-server.ts`) — no socket, no network. Verified
output:

```
── 1. Offline proof — real MCP client, in-process server ───────────────
  ✅ initialize + tools/list advertised 3 tools
      • google.gmail.list — Read recent Gmail messages (sender, subject, snippet).
      • google.calendar.list — List upcoming events from the primary calendar.
      • google.calendar.create — Create an event on the primary calendar.
  ✅ AI SDK toolset keys match the server tools
  ✅ tools/call round-trips through the MCP client
  JSON-RPC methods seen: initialize → notifications/initialized → tools/list → tools/list → tools/call
  ✅ handshake order is initialize → notifications/initialized → tools/list

── 2. Deriving Diggy’s plugin registry + gallery rows from MCP ─────────
  ✅ one provider (google) with three actions
  ✅ gallery rows carry the current ApiPlugin fields
  ✅ MCP cannot say “connected” — that stays false (the gap)
  ✅ MCP tools merge alongside built-ins
  ✅ a shadowing tool name is rejected, not silently overwritten
```

Concretely, it proves:

1. The MCP **JSON-RPC handshake works end to end** with the shipped SDK version
   (`initialize` → `notifications/initialized` → `tools/list` → `tools/call`).
2. An MCP server's tools become **ordinary AI SDK tools** (`client.tools()`), so
   adding a whole provider is one spread into the model's toolset — no
   per-provider route.
3. Diggy's plugin model can be **derived from the tool list**: `provider.action`
   names reconstruct the `PROVIDERS` registry and the `GET /plugins` /
   `PluginsPanel` row shape (`src/plugin-shim.ts`), and a remote tool cannot
   shadow a built-in (`mergeToolsets` throws on collision).
4. A real remote SSE connect **fails fast and visibly** with no server
   (`TypeError: fetch failed`), which is the honest state of the live path here.

## What it does **not** prove

- No **live** MCP server was contacted (no network, no server available).
- The **OAuth-to-MCP** flow, per-user tokens, and `connected`/`accountLabel` —
  MCP has no notion of these; the shim leaves them empty on purpose.
- **Browser/extension** viability: whether an MV3 service worker can hold an SSE
  connection, and how the extension CSP treats it, is untested.
- Google's **restricted-scope** verification story (`gmail.readonly`) — MCP does
  not change it. See `docs/GOOGLE_SCOPES.md`.

## Files

| File | Purpose |
|---|---|
| `src/ai.ts` | Loads the already-installed `ai`; no new dependency. |
| `src/fake-server.ts` | In-process MCP server double (implements `MCPTransport`). |
| `src/remote-client.ts` | The headline: connect to a **remote** MCP server over SSE and get its tools. |
| `src/plugin-shim.ts` | Maps MCP tools onto Diggy's `PROVIDERS` registry + gallery rows. |
| `src/smoke.ts` | Runnable proof (offline, plus optional `--live`). |
