/**
 * `@diggy/page-agent` — the **act layer** for the browser agent.
 *
 * A content-script package that (1) turns a page into a compact, capped list of
 * visible interactive elements and (2) performs actions against them, with every
 * action gated by `@diggy/policy` and every secret redacted.
 *
 * ## What it exports
 *
 * - **Snapshot** — {@link PageAgent.snapshot} / {@link snapshot}, {@link buildSnapshot},
 *   {@link MAX_SNAPSHOT_ENTRIES}, {@link buildSnapshot | PageSnapshot}.
 * - **Actions** — {@link PageAgent.click | click}, {@link PageAgent.type | type},
 *   {@link PageAgent.select | select}, {@link PageAgent.pressKey | pressKey},
 *   {@link PageAgent.scroll | scroll}, {@link PageAgent.waitFor | waitFor},
 *   {@link PageAgent.navigate | navigate}, {@link PageAgent.goBack | goBack}.
 *   Each returns an {@link ActionResult}.
 * - **Agent** — {@link createPageAgent}, {@link PageAgent}, {@link defaultPageAgent}
 *   (a module singleton for content-script use).
 * - **Policy** — {@link ACTION_TOOL}, {@link evaluateGate}, {@link submitRefusal}.
 * - **Input seam** — {@link TrustedInputAdapter}, {@link NullInputAdapter}.
 * - **Avatar** — {@link stateToAvatar}, {@link STATE_TO_AVATAR}.
 * - **Redaction** — {@link REDACTED_VALUE}, {@link VAULT_ATTRIBUTE}.
 *
 * ## The never-auto-submit rule
 * A click or `Enter` on a submit/send/delete/purchase control is classified as
 * the policy's `submit` tool (irreversible → always `confirm`) and is **never
 * executed** by this package: the action returns `ok: false, decision: 'confirm'`
 * and the user presses it.
 *
 * ## The snapshot cap
 * A snapshot returns at most {@link MAX_SNAPSHOT_ENTRIES} entries. Over that,
 * non-interactive elements are never collected and off-screen elements are
 * dropped before on-screen ones; `truncated` / `droppedOffscreen` report the rest.
 */
export * from './types';
export * from './dom';
export * from './controls';
export * from './input-adapter';
export * from './policy-gate';
export * from './ref-registry';
export * from './snapshot';
export * from './agent';
export * from './avatar';

import { createPageAgent } from './agent';
import type { PageAgent } from './agent';
import type { ActionOptions, PageSnapshot, ScrollInput, SnapshotOptions, WaitInput } from './types';

let defaultAgent: PageAgent | null = null;

/**
 * The process-wide agent, created on first use. A content script has exactly one
 * page, so a module singleton is the right default; tests and hosts that need
 * isolation should call {@link createPageAgent} directly.
 */
export function defaultPageAgent(): PageAgent {
  defaultAgent ??= createPageAgent();
  return defaultAgent;
}

/* eslint-disable @typescript-eslint/no-shadow -- these thin wrappers deliberately
   carry the action names so a caller can write `import { click } from '@diggy/page-agent'`. */

/** Snapshot the current page (see the package docs for the cap). */
export function snapshot(options?: SnapshotOptions): PageSnapshot {
  return defaultPageAgent().snapshot(options);
}

/** Click the element a fresh snapshot tagged `ref`. */
export function click(ref: number, options?: ActionOptions) {
  return defaultPageAgent().click(ref, options);
}

/** Type `text` into the element a fresh snapshot tagged `ref`. */
export function type(ref: number, text: string, options?: ActionOptions) {
  return defaultPageAgent().type(ref, text, options);
}

/** Choose a `<select>` option by value or label. */
export function select(ref: number, value: string, options?: ActionOptions) {
  return defaultPageAgent().select(ref, value, options);
}

/** Press a key on the focused element. */
export function pressKey(key: string, options?: ActionOptions) {
  return defaultPageAgent().pressKey(key, options);
}

/** Scroll by a direction, a pixel amount, or both. */
export function scroll(input: ScrollInput, options?: ActionOptions) {
  return defaultPageAgent().scroll(input, options);
}

/** Wait for text, a selector, or a fixed time. */
export function waitFor(input: WaitInput, options?: ActionOptions) {
  return defaultPageAgent().waitFor(input, options);
}

/** Navigate the page (refused for sensitive sites). */
export function navigate(url: string, options?: ActionOptions) {
  return defaultPageAgent().navigate(url, options);
}

/** Go back in history. */
export function goBack(options?: ActionOptions) {
  return defaultPageAgent().goBack(options);
}
