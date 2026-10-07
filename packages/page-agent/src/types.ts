/**
 * `@diggy/page-agent` — the **act layer** vocabulary.
 *
 * This package is the DOM half of the agent loop: it turns a live page into a
 * compact list of actionable elements ({@link PageSnapshot}) and executes
 * actions against them. It is written against the real DOM (content-script
 * first) but every function is pure enough to run under jsdom.
 *
 * Two hard rules shape the types:
 *
 * 1. **A secret is never leaked.** {@link SnapshotEntry.value} is
 *    {@link REDACTED_VALUE} for password inputs and vault-filled fields, so a
 *    model message can never echo a credential.
 * 2. **A ref is only valid for the snapshot that produced it.** A ref whose
 *    element is gone or replaced resolves to a *stale* error, never to a
 *    different element (see {@link ActionResult}).
 */
import type { ConfirmPayload, Decision } from '@diggy/policy';
import type { AvatarMood, AvatarState } from '@diggy/shared';

/** A viewport-relative rectangle, in CSS pixels. */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A viewport size used when the real one is unavailable (tests). */
export interface ViewportSize {
  width: number;
  height: number;
}

/**
 * One actionable element in a snapshot.
 *
 * Every field is chosen for the model: a stable handle (`ref`), what the element
 * *is* (`role`, `type`), what it is *called* (`name`), its current `value`
 * (redacted when secret-bearing) and where it sits (`bbox`, `inViewport`).
 */
export interface SnapshotEntry {
  /** A number that is unique within the page-agent and increments per snapshot. */
  ref: number;
  /** The ARIA role (explicit `role=` wins; otherwise inferred from the tag/type). */
  role: string;
  /** The accessible name, from `aria-label`/`<label>`/text/`placeholder`/… */
  name: string;
  /** The control type (`text`, `password`, `submit`, `select`, …), when meaningful. */
  type?: string;
  /** Current value. {@link REDACTED_VALUE} for secrets. Omitted for controls with none. */
  value?: string;
  /** Viewport-relative box. All zeros under jsdom, which has no layout engine. */
  bbox: BoundingBox;
  /** Does the box intersect the viewport? (Always `false` under jsdom unless stubbed.) */
  inViewport: boolean;
}

/**
 * The result of {@link buildSnapshot}: the visible, interactive surface of a
 * page (or of one shadow/iframe scope), capped at {@link MAX_SNAPSHOT_ENTRIES}.
 */
export interface PageSnapshot {
  url: string;
  title: string;
  entries: SnapshotEntry[];
  /** How many interactive candidates were found **before** the cap. */
  total: number;
  /** True when the cap dropped at least one candidate. */
  truncated: boolean;
  /** How many candidates were dropped because they were off-screen. */
  droppedOffscreen: number;
}

/**
 * What an action reports back.
 *
 * `ok` is true only when the action actually ran. A policy `confirm`/`deny` and
 * a stale ref are `ok: false` with a `decision` and an `error`; `summary` always
 * describes the attempted page change in a sentence the model can use.
 */
export interface ActionResult {
  ok: boolean;
  /** A one-line description of the page change (or of why it did not happen). */
  summary: string;
  /** Present when `ok` is false — safe to show the model, and to log. */
  error?: string;
  /** What the policy layer decided. `allow` when the action ran. */
  decision: Decision;
  /** Present for a `confirm` — the payload the host shows the user. */
  confirm?: ConfirmPayload;
}

/** Per-call options. `approved` is set by the host after the user confirms. */
export interface ActionOptions {
  /** The user has approved a gated action; `confirm` no longer blocks it. */
  approved?: boolean;
}

/** Options for {@link buildSnapshot} / {@link PageAgent.snapshot}. */
export interface SnapshotOptions {
  /** Scope to scan. Defaults to `document`. */
  root?: ParentNode;
  /** Override the cap (defaults to {@link MAX_SNAPSHOT_ENTRIES}). */
  max?: number;
  /** Override the viewport size (defaults to `window.innerWidth/innerHeight`). */
  viewport?: ViewportSize;
}

/**
 * The agent's coarse state — the thing the avatar reacts to. Mapped to
 * {@link AvatarCue} by `stateToAvatar`.
 */
export type AgentState = 'thinking' | 'reading' | 'acting' | 'waiting-approval' | 'error' | 'done';

/** A resolved avatar reaction borrowed from `@diggy/shared`. */
export interface AvatarCue {
  mood: AvatarMood;
  state: AvatarState;
}

/** Scroll axis direction. */
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/**
 * `scroll` accepts a direction, a pixel amount, or both.
 *
 * - `'down'` — scroll down by {@link DEFAULT_SCROLL_AMOUNT}.
 * - `600`    — scroll down 600px.
 * - `{ direction: 'right', amount: 250 }`.
 */
export type ScrollInput = ScrollDirection | number | { direction?: ScrollDirection; amount?: number };

/**
 * `waitFor` accepts a bare string (treated as **text**), a number of
 * milliseconds, or an explicit object. Use the object form to disambiguate a
 * selector from text.
 */
export type WaitInput =
  | string
  | number
  | {
      /** Wait until this text appears anywhere in the page. */
      text?: string;
      /** Wait until this selector matches an element. */
      selector?: string;
      /** Just wait this long (milliseconds). */
      ms?: number;
      /** Give up after this long (milliseconds). Defaults to the agent's timeout. */
      timeoutMs?: number;
    };
