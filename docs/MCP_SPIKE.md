# MCP spike — findings

> **Status: spike, not shipped.** The code lives in [`../spikes/mcp/`](../spikes/mcp/);
> nothing under `apps/`, `packages/` or `services/` imports it. This page records
> what was actually built and run, what was not, and whether MCP should replace
> the current connectors.

Last updated: 2026-10-07 · Branch `main`.

---

## 1. What was spiked, and against what

The current model is three hand-written pieces:

- **registry** — `services/api/src/providers.ts` (`PROVIDERS`, and `GOOGLE_SCOPES`);
- **action switch** — `services/api/src/routes/actions.ts`
  (`ROUTES`, `POST /actions/:provider/:action`);
- **connection flow** — `services/api/src/routes/plugins.ts`
  (`GET /plugins`, `/oauth/:provider/start|callback|disconnect`) plus the UI in
  `apps/extension/entrypoints/sidepanel/PluginsPanel.tsx` and
  `apps/extension/src/api-client.ts`.

The spike asks: can a **remote MCP server** replace (1) and (2), with the backend
reduced to an MCP gateway and the gallery rendered from the server's own tool
list?

**Dependency result (no new package added):**

| Capability | Provided by | Installed? |
|---|---|---|
| `experimental_createMCPClient` + inline `type: 'sse'` transport | `ai@4.3.19` (`@diggy/core` dependency) | ✅ |
| stdio transport (`ai/mcp-stdio`) | same | ✅ |
| `@modelcontextprotocol/sdk` | — | ❌ absent, and **not required** for SSE |

So the AI SDK's MCP support was already in the tree; the spike uses it and adds
nothing.

## 2. What worked

`spikes/mcp/src/smoke.ts` drives the **real** `experimental_createMCPClient`
against an **in-process** MCP server double (`src/fake-server.ts`) — no socket,
no network. All of the following were executed and passed:

1. **Handshake.** The client ran `initialize` → `notifications/initialized` →
   `tools/list` → `tools/call` against the server double. The client pins
   protocol `2024-11-05` (accepting `2024-10-07`).
2. **Tool conversion.** `client.tools()` returned the server's three tools as
   ordinary AI SDK `Tool`s, keyed by their MCP names
   (`google.gmail.list`, `google.calendar.list`, `google.calendar.create`).
3. **Tool call round-trip.** Invoking a returned tool's `execute()` sent
   `tools/call` and surfaced the server's text content unchanged.
4. **Registry derivation.** `provider.action` MCP names reconstruct the
   `PROVIDERS` shape (one provider, three actions) and the `ApiPlugin` row
   shape `PluginsPanel` renders — i.e. the registry becomes *data*.
5. **Safe merge.** `mergeToolsets()` refuses to let a remote tool shadow a
   built-in (`readInbox`, `readPage`, …) instead of silently overwriting it.

This is enough to say the **integration cost is ~30 lines** and needs no new
dependency.

## 3. What did **not** work / surprising findings

- **The AI SDK client's `listTools()` and `callTool()` are `private`** in
  `ai@4.3.19` (see the `MCPClient` declaration). `tools()` is the only public
  discovery surface, and the only way to call a tool is through the returned
  tool's `execute()`. A production integration must go through `tools()`.
- **Authentication is out of scope of the transport.** The `type: 'sse'`
  transport accepts **static headers only** — there is no OAuth/authorization
  handshake in the client. A remote MCP server that needs user-consented OAuth
  has no first-class path here; you would have to obtain a token yourself and
  pass it as a header, which reintroduces exactly the token-custody problem the
  backend already solves.
- **`serverInfo` / icons are not exposed.** The client keeps the `initialize`
  result private, so the spike can only derive gallery rows from tool names and
  descriptions — no server name/logo for the panel.

## 4. What could **not** be tested (stated plainly)

- **No live MCP server and no network.** Every network path is unexercised. The
  `--live` option was run against an unreachable URL and failed visibly with
  `TypeError: fetch failed`; that is the only remote result.
- The **in-process server is a double**, not a real server. It exercises the
  *client* half of MCP faithfully, but it is not evidence that any real server's
  tool schemas, error shapes, pagination, or streaming behave the same.
- **OAuth / per-user authorisation, token refresh, and revocation** across an MCP
  boundary — untested and, per §3, not directly supported by this client.
- **Browser/extension viability** — whether an MV3 service worker can hold an SSE
  connection, and how the extension CSP treats it. Untested.
- **stdio transport** — inspected only (it exists at `ai/mcp-stdio` and pulls in
  `child_process`, so it is Node-only and irrelevant to a browser extension), not
  run.
- **Behaviour against the real Google API** through MCP — untested; the fake
  returns canned JSON.

## 5. Trade-offs vs. the current local-OAuth backend

| Dimension | Current local backend | Remote MCP server |
|---|---|---|
| **Token custody** | Client secrets stay on the user's machine; refresh tokens encrypted (AES-256-GCM) in local SQLite; server binds `127.0.0.1` with a service-auth guard. | The MCP server holds/uses the provider token; a third party enters the trust boundary. |
| **Per-user consent & account identity** | Explicit, owned: `Connected ✓`, `accountLabel` (email/login/workspace), `Disconnect`. | MCP has no first-class notion of "connected account"; the spike leaves `connected`/`accountLabel` empty. |
| **Google restricted scopes** | Unchanged problem: `gmail.readonly` is **restricted** → verification + annual security assessment (`docs/GOOGLE_SCOPES.md`). | **Identical** — the tier is attached to the scope, not the transport. MCP does not lower the bar. |
| **Adding a provider** | New code in `providers.ts` + `actions.ts` + (optionally) the UI. | The server advertises tools; ~one spread into the toolset. |
| **Third-party availability** | You own it. | A new external dependency per server (uptime, latency, breaking changes, tool-name churn). |
| **Security surface** | Known local code. | Every MCP server can return arbitrary tool output (prompt-injection surface) and must be trusted or sandboxed. |
| **Coverage** | Exactly the providers you build. | Only providers that publish a server; many are read-mostly and not the ones Diggy ships today. |
| **Offline / privacy** | Works offline; nothing leaves the machine. | Requires the network to a third party even for local-account reads. |

## 6. Recommendation

**Do not replace the local-OAuth backend now. Keep it as the default, and add MCP
as an optional, flagged extension point later.** Reasons:

1. **MCP does not solve Diggy's actual blocker.** The gating item for a public
   Gmail launch is Google's restricted-scope verification + CASA, which MCP
   leaves untouched. Replacing the connector would not move that needle.
2. **The backend already solves consent, identity and token custody** — the
   three things MCP is weakest at here (static-header auth only, no connected-
   account concept). Giving that up for a slightly smaller diff is a bad trade.
3. **Local-first is a product property.** Diggy advertises that tokens stay
   encrypted on-device and the helper binds loopback. Routing reads through a
   third-party MCP server is a visible change to that promise.
4. **The option value is real and cheap.** The integration is ~30 lines against
   an SDK already in the tree, so the right move is to keep the door open: a
   single gateway in the existing backend that can also speak MCP, merging a
   remote server's tools into the same toolset behind a default-OFF flag, with
   the collision rule from `mergeToolsets()` enforced.
5. **Best-fit use of MCP if adopted:** *new*, read-mostly, self-describing
   providers that already ship a server (search, docs, issue trackers) — not the
   first-party apps whose OAuth apps Diggy already owns.

If a pilot is wanted, do it as: one provider, behind a flag, reads only, with a
human-readable "tools unavailable" fallback when the MCP server is down — never
as the sole path for a provider Diggy already supports.

---

## Appendix A — Gmail behind a feature flag (default OFF), proposed wiring

**Not applied by this phase.** The flag has to live in the extension's shipped
source (`apps/extension/src/*`), which this phase does not own, so the exact diff
is recorded here for the coordinator instead of being edited in.

The Gmail read path has a single choke point: `readInboxSmart()` in
`apps/extension/src/accounts.ts` (line ~47). It is reached from the `readInbox`
tool (`packages/core/src/tools/index.ts:142` → `apps/extension/src/agent.ts:154`
and `apps/extension/src/platform-context.ts:418`) and from the background watcher
(`apps/extension/entrypoints/background.ts:875`).

**Proposed predicate** — add to `apps/extension/src/storage.ts` (beside
`isAvatarDisabledForHost`), plus a settings field:

```ts
// Settings (interface):
/** Feature flag: Gmail reading. Default OFF. */
gmailEnabled: boolean;

// DEFAULT_SETTINGS:
gmailEnabled: false,

/**
 * Feature flag: Gmail reading (inbox tool + background watcher). Defaults OFF —
 * absent settings count as disabled, so a build without the field ships with
 * Gmail off. Flip `settings.gmailEnabled = true` to opt in.
 */
export function gmailEnabled(settings: Settings | null | undefined): boolean {
  return settings?.gmailEnabled === true;
}
```

**The one-line wiring** — at the top of `readInboxSmart()`
(`apps/extension/src/accounts.ts`), immediately after `const settings = await getSettings();`:

```ts
if (!gmailEnabled(settings)) throw new Error('Gmail reading is disabled (feature flag off).');
```

with `import { getSettings, gmailEnabled } from './storage';`.

**Recommended extra guard** (so the watcher does not throw every poll) —
`apps/extension/entrypoints/background.ts:873`:

```ts
if (settings.gmailWatch && gmailEnabled(settings)) {
```

No existing code is deleted; the OAuth path (`google.ts`), the session-feed path
(`gmail-session.ts`) and the `readInbox` tool all remain intact — they are simply
unreachable for reads while the flag is off.
