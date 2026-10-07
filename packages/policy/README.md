# @diggy/policy — agent security policy layer

A dependency-free gate that sits **between the model and the tool executors**.
Before any `ToolContext` method runs, ask this package what to do.

- **Tool classification** — every tool is `read | write | irreversible`. Unknown
  tools are `unknown` and **denied**, never defaulted to allow.
- **`decide(tool, args, context)`** → `{ decision: 'allow' | 'confirm' | 'deny', reason, confirmPayload? }`.
- **Taint tracking** — once untrusted content (web page, transcript, signed-in tab
  read, plugin result) is in context, every *outward-effect* tool must `confirm`.
- **Untrusted-text delimiting** — fence third-party text as a labelled **DATA**
  block, plus the system-prompt paragraph to inject.
- **Sensitive-site blocklist** — banks, payment pages, password managers and
  health portals are denied for reads *and* actions by default, with a
  user-configurable per-site allow list.
- **Quarantined reader contract** — signed-in page reads never reach the
  tool-using agent; only a no-tools reader's summary does.
- **Vault safety** — `redactForModel()` + a sentinel so vault values can never be
  serialised into a model message.

Zero runtime dependencies, no DOM / `chrome` at module scope, and nothing throws
on garbage input (non-strings are coerced; the vault walk is cycle-safe).

## Layout

```
src/types.ts       shared vocabulary (ToolCategory, Decision, PolicyContext, …)
src/classify.ts    TOOL_CLASSIFICATION, classifyTool, isOutwardEffect
src/decide.ts      decide()
src/taint.ts       markUntrusted, isTainted, resetTaint, getTaintState
src/sites.ts       isSensitiveSite, sensitiveSiteCategory, isSiteAllowlisted
src/untrusted.ts   wrapUntrusted, buildUntrustedGuard, detectInjection
src/quarantine.ts  summarizeUntrusted, QUARANTINE_CALLER_OBLIGATION
src/vault.ts       redactForModel, VAULT_SENTINEL, registerVaultValue(s)
```

## Usage

```ts
import { decide, markUntrusted, isSensitiveSite } from '@diggy/policy';

// Gate every tool call the model requests.
const result = decide(toolName, args, { origin: 'user', siteAllowlist: userAllowlist });
if (result.decision === 'deny') return refuse(result.reason);
if (result.decision === 'confirm') return askUser(result.confirmPayload);
runTool(toolName, args);

// Whenever untrusted content enters the turn:
markUntrusted('web page', pageText);          // from now on, outward tools confirm

// Fence untrusted text before the model sees it:
const block = wrapUntrusted('gmail inbox', rawInboxText);

// Signed-in page read: never hand the raw text to the tool-using agent.
const { summary } = await summarizeUntrusted(rawPage, (fenced) => summariseWithNoTools(fenced));

// Vault values:
registerVaultValue(profile.secrets.pan);
const safe = redactForModel({ role: 'user', content: message });
```

## Wiring the coordinator must do (outside this package)

1. **Call `decide` before every tool executor.** In `packages/core`'s orchestrator
   (`runAgent`), wrap the per-call dispatch so each tool call is `allow` /
   `confirm` / `deny`. This package deliberately has no dependency on
   `@diggy/core`; add `"@diggy/policy": "workspace:*"` to `packages/core` (and to
   `apps/extension` / `apps/desktop` if they gate calls there too).
2. **Inject the guard into the system prompt.** Append `buildUntrustedGuard()` to
   `buildSystemPrompt()` in `packages/core/src/prompt.ts`.
3. **Mark taint at the sources.** Call `markUntrusted(source, text)` in the host
   when `readPage`/`crawl`/`searchWeb`/`readInbox`/`readCalendar` results (and
   plugin results, and signed-in tab reads) are added to the turn; `resetTaint()`
   at the start of a fresh trusted turn.
4. **Route signed-in reads through `summarizeUntrusted`.** The tool-using agent
   must only ever see the returned `summary`.
5. **Register vault values** with `registerVaultValue`/`registerVaultValues` when
   the vault unlocks, and run every model-bound payload that could contain them
   through `redactForModel`.
6. **Thread the user's per-site allow list** into `PolicyContext.siteAllowlist`.

## Commands

```bash
pnpm --filter @diggy/policy exec tsc --noEmit
pnpm --filter @diggy/policy test
```
