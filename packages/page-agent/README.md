# @diggy/page-agent

The **act layer** for the browser agent: a content-script package that turns a
page into a compact list of actionable elements and performs actions against
them. Every action is gated by [`@diggy/policy`](../policy) and every secret is
redacted.

- Written against the **real DOM** (content-script first), unit-tested under
  **jsdom** (no browser).
- **Zero runtime dependencies** beyond `@diggy/policy` and `@diggy/shared`
  (type-only). `jsdom` is used only as a dev dependency for tests.

## API

```ts
import { createPageAgent } from '@diggy/page-agent';

const agent = createPageAgent();

const snapshot = agent.snapshot();            // PageSnapshot
await agent.click(3);                         // ActionResult
await agent.type(4, 'hello@example.com');
await agent.select(5, 'Weekly');
await agent.pressKey('Tab');
await agent.scroll('down');                    // or 600, or { direction: 'right', amount: 250 }
await agent.waitFor({ text: 'Welcome' });      // or { selector }, or { ms }, or a bare string/number
await agent.navigate('https://example.com');
await agent.goBack();
```

There is also a module-level singleton for content-script use:
`snapshot()`, `click()`, `type()`, `select()`, `pressKey()`, `scroll()`,
`waitFor()`, `navigate()`, `goBack()` delegate to `defaultPageAgent()`.

Every action returns an `ActionResult`:

```ts
interface ActionResult {
  ok: boolean;          // true only when the action actually ran
  summary: string;      // one line describing the page change
  error?: string;       // present when ok is false
  decision: 'allow' | 'confirm' | 'deny';
  confirm?: ConfirmPayload;  // present for a `confirm`
}
```

## The snapshot and its cap

`snapshot()` returns `{ url, title, entries, total, truncated, droppedOffscreen }`.
Each entry is `{ ref, role, name, type?, value?, bbox, inViewport }`.

- **Coverage**: open shadow roots and same-origin iframes are traversed (up to
  depth 10). Cross-origin iframes are skipped (unreadable anyway).
- **Cap**: the list is hard-capped at `MAX_SNAPSHOT_ENTRIES` (**100**).
  What is dropped **first**, in order:
  1. **non-interactive elements** — never collected at all (inert text, layout
     `<div>`s, decorative markup, hidden/disabled controls);
  2. **off-screen candidates** — every in-viewport element is kept before any
     off-screen one.
  `truncated` and `droppedOffscreen` report what the cap discarded.
- **Redaction**: `value` is `[[REDACTED]]` for `input[type=password]`, for any
  element carrying `data-diggy-vault`, and for any value containing a
  `registerVaultValue` secret. A secret can never reach the model.

## Never auto-submit

A click or `Enter` on a submit/send/delete/purchase control is classified as the
policy's `submit` tool — an `irreversible` class, so `decide()` returns
`confirm`. The action then returns `ok: false, decision: 'confirm'` with the
confirm payload and **does not touch the page**, even when the host passes
`{ approved: true }`. The user presses the control.

## Stale refs

A ref is valid only for the snapshot that produced it. Acting on a ref whose
element is `gone`, `replaced`, or `unknown` fails with a "Take a new snapshot()"
error and never touches a different element.

## The trusted-input seam

`TrustedInputAdapter` is the interface for a future `chrome.debugger`-based
real-input path (`Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`). It is
**defined but not implemented** here; `NullInputAdapter` is the safe default that
is always unavailable, so the synthetic-DOM path runs.

## Avatar

`stateToAvatar('thinking' | 'reading' | 'acting' | 'waiting-approval' | 'error' | 'done')`
maps an agent state to an `@diggy/shared` `AvatarMood` + `AvatarState`.

## Scripts

```bash
pnpm --filter @diggy/page-agent exec tsc --noEmit   # typecheck
pnpm --filter @diggy/page-agent test                # vitest (jsdom)
```
