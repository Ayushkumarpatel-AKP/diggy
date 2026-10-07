/**
 * The act layer proper: `createPageAgent()` and its eight actions.
 *
 * A `PageAgent` owns one {@link RefRegistry} (shared with its `snapshot()`) so
 * the refs it hands out are the refs it can resolve. Every action follows the
 * same shape:
 *
 *  1. resolve the ref — a stale ref short-circuits with a clear "take a new
 *     snapshot" error and **nothing is touched**;
 *  2. gate the action through `@diggy/policy` (`evaluateGate`);
 *  3. execute it with synthetic DOM events (or, one day, the
 *     {@link TrustedInputAdapter}); and
 *  4. return an {@link ActionResult} whose `summary` describes the page change.
 *
 * Two refusal rules are hard-coded on purpose:
 *  - a submit/send/delete/purchase control is **never** clicked or triggered by
 *    a key press — the action returns `confirm` and the user presses it;
 *  - a redacted value is never echoed back in a `summary`.
 */
import type { PolicyContext } from '@diggy/policy';
import { isSubmitControl, isSubmitKey } from './controls';
import {
  accessibleName,
  deriveRole,
  descriptiveText,
  dispatch,
  dispatchKey,
  isHtmlElement,
  isSelectElement,
  isTextEntry,
  setFieldValue,
} from './dom';
import { NullInputAdapter } from './input-adapter';
import type { TrustedInputAdapter } from './input-adapter';
import { ACTION_TOOL, evaluateGate, submitRefusal } from './policy-gate';
import { RefRegistry } from './ref-registry';
import { buildSnapshot } from './snapshot';
import type { StaleReason } from './types-internal';
import type {
  ActionOptions,
  ActionResult,
  PageSnapshot,
  ScrollDirection,
  ScrollInput,
  SnapshotOptions,
  WaitInput,
} from './types';

/** Default scroll distance when only a direction is given. */
export const DEFAULT_SCROLL_AMOUNT = 400;

/** Default `waitFor` deadline. */
export const DEFAULT_WAIT_TIMEOUT_MS = 5000;

/** `waitFor` polling interval. */
const WAIT_POLL_MS = 50;

/** Escape hatches for the effects that leave the DOM tree (navigation, scroll). */
export interface PageAgentHooks {
  navigate?(url: string): void | Promise<void>;
  goBack?(): void | Promise<void>;
  scrollBy?(deltaX: number, deltaY: number): void | Promise<void>;
}

/** Everything {@link createPageAgent} accepts. All optional — sensible defaults for a content script. */
export interface PageAgentOptions {
  /** Policy context (`origin`, `taint`, `siteAllowlist`). `url` defaults to `location.href`. */
  policy?: PolicyContext;
  /** Share a ref registry (defaults to a private one). */
  registry?: RefRegistry;
  /** The real-input seam. Defaults to {@link NullInputAdapter}. */
  input?: TrustedInputAdapter;
  /** Default `waitFor` deadline in ms. */
  timeoutMs?: number;
  /** Injected sleep (tests). */
  sleep?(ms: number): Promise<void>;
  /** Injected clock (tests), in ms. */
  now?(): number;
  /** Injected navigation/scroll effects (tests, or a host with its own router). */
  hooks?: PageAgentHooks;
}

/** The act layer's public surface. */
export interface PageAgent {
  /** A capped list of visible, interactive elements with fresh refs. */
  snapshot(options?: SnapshotOptions): PageSnapshot;
  /** Click a previously snapshotted element. */
  click(ref: number, options?: ActionOptions): Promise<ActionResult>;
  /** Type text into a field (the text is never echoed back). */
  type(ref: number, text: string, options?: ActionOptions): Promise<ActionResult>;
  /** Choose an option in a `<select>`. */
  select(ref: number, value: string, options?: ActionOptions): Promise<ActionResult>;
  /** Press a key on the focused element (Enter-in-a-form is treated as submit). */
  pressKey(key: string, options?: ActionOptions): Promise<ActionResult>;
  /** Scroll the page by a direction or a pixel amount. */
  scroll(input: ScrollInput, options?: ActionOptions): Promise<ActionResult>;
  /** Wait for text, a selector, or a fixed time. */
  waitFor(input: WaitInput, options?: ActionOptions): Promise<ActionResult>;
  /** Navigate the page to a URL (refused for sensitive sites). */
  navigate(url: string, options?: ActionOptions): Promise<ActionResult>;
  /** Return to the previous page. */
  goBack(options?: ActionOptions): Promise<ActionResult>;
  /** The registry this agent's refs live in. */
  readonly registry: RefRegistry;
  /** The input adapter reserved for the future trusted-input path. */
  readonly input: TrustedInputAdapter;
}

function ok(summary: string): ActionResult {
  return { ok: true, decision: 'allow', summary };
}

function fail(summary: string, error: string): ActionResult {
  return { ok: false, decision: 'deny', summary, error };
}

const STALE_PHRASE: Readonly<Record<StaleReason, string>> = {
  unknown: 'was never handed out by a snapshot',
  gone: 'no longer exists in the page',
  replaced: 'now points to a different element',
};

/** The error the agent gets when it acts on a ref from an outdated snapshot. */
function staleRefResult(ref: number, reason: StaleReason): ActionResult {
  const phrase = STALE_PHRASE[reason];
  return fail(
    `Ref ${ref} is stale — it ${phrase}.`,
    `Ref ${ref} is stale (it ${phrase}); the page changed. Take a new snapshot() and use the fresh ref before acting.`,
  );
}

interface WaitSpec {
  ms?: number;
  selector?: string;
  text?: string;
  timeoutMs: number;
  label: string;
}

function normalizeWait(input: WaitInput, defaultTimeout: number): WaitSpec {
  if (typeof input === 'number') {
    const ms = Math.max(0, Math.floor(input));
    return { ms, timeoutMs: defaultTimeout, label: `${ms}ms` };
  }
  if (typeof input === 'string') {
    return { text: input, timeoutMs: defaultTimeout, label: `text "${input}"` };
  }
  const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : defaultTimeout;
  if (typeof input.ms === 'number') {
    const ms = Math.max(0, Math.floor(input.ms));
    return { ms, timeoutMs, label: `${ms}ms` };
  }
  if (typeof input.selector === 'string' && input.selector) {
    return { selector: input.selector, timeoutMs, label: `selector "${input.selector}"` };
  }
  if (typeof input.text === 'string' && input.text) {
    return { text: input.text, timeoutMs, label: `text "${input.text}"` };
  }
  return { ms: 0, timeoutMs, label: '0ms' };
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

function parseScroll(input: ScrollInput): { dx: number; dy: number; label: string } {
  let direction: ScrollDirection = 'down';
  let amount = DEFAULT_SCROLL_AMOUNT;
  if (typeof input === 'number') {
    amount = Math.abs(input) || DEFAULT_SCROLL_AMOUNT;
  } else if (typeof input === 'string') {
    direction = input;
  } else {
    if (input.direction) direction = input.direction;
    if (typeof input.amount === 'number') amount = Math.abs(input.amount) || DEFAULT_SCROLL_AMOUNT;
  }
  const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
  const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
  return { dx, dy, label: `${direction} ${amount}px` };
}

/**
 * Create an act-layer agent.
 *
 * @param options policy context, hooks and test seams. The defaults are correct
 *   for a content script running in a real page.
 */
export function createPageAgent(options: PageAgentOptions = {}): PageAgent {
  const registry = options.registry ?? new RefRegistry();
  const input = options.input ?? new NullInputAdapter();
  const hooks = options.hooks ?? {};
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const now = options.now ?? (() => Date.now());
  const defaultTimeout = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;

  const win = (): Window | null => (typeof window !== 'undefined' ? window : null);

  const currentUrl = (): string => {
    try {
      return typeof location !== 'undefined' ? location.href : '';
    } catch {
      return '';
    }
  };

  const policyContext = (): PolicyContext => {
    const ctx: PolicyContext = { ...(options.policy ?? {}) };
    if (ctx.url === undefined) ctx.url = currentUrl();
    return ctx;
  };

  const labelFor = (el: HTMLElement): string =>
    accessibleName(el) || descriptiveText(el) || deriveRole(el);

  const activeElement = (): Element | null =>
    typeof document !== 'undefined' ? document.activeElement ?? null : null;

  function snapshot(opts?: SnapshotOptions): PageSnapshot {
    return buildSnapshot(registry, opts);
  }

  async function click(ref: number, opts: ActionOptions = {}): Promise<ActionResult> {
    const resolution = registry.resolve(ref);
    if (!resolution.ok) return staleRefResult(ref, resolution.reason);
    const element = resolution.element;
    const name = labelFor(element);

    if (isSubmitControl(element)) {
      return submitRefusal(
        { ref, control: name, role: deriveRole(element) },
        policyContext(),
        `Refused to click the submit control "${name}" (ref ${ref}).`,
      );
    }

    const outcome = evaluateGate({
      tool: ACTION_TOOL.click,
      args: { ref, control: name },
      context: policyContext(),
      approved: opts.approved === true,
      summary: `Click "${name}" (ref ${ref})`,
    });
    if (!outcome.allowed) return outcome.blocked;

    if (typeof element.click === 'function') element.click();
    else dispatch(element, 'click');

    return ok(`Clicked "${name}" (${deriveRole(element)}, ref ${ref}).`);
  }

  async function type(ref: number, text: string, opts: ActionOptions = {}): Promise<ActionResult> {
    const resolution = registry.resolve(ref);
    if (!resolution.ok) return staleRefResult(ref, resolution.reason);
    const element = resolution.element;

    if (!isTextEntry(element)) {
      return fail(
        `Ref ${ref} is not a text field.`,
        `Ref ${ref} is a "${deriveRole(element)}" element, not a text field. Take a new snapshot() and choose an input, textarea or contenteditable.`,
      );
    }

    const name = labelFor(element);
    const outcome = evaluateGate({
      tool: ACTION_TOOL.type,
      args: { ref, field: name, length: text.length },
      context: policyContext(),
      approved: opts.approved === true,
      summary: `Type into "${name}" (ref ${ref})`,
    });
    if (!outcome.allowed) return outcome.blocked;

    setFieldValue(element, text);
    return ok(
      `Typed ${text.length} character${text.length === 1 ? '' : 's'} into "${name}" (${deriveRole(element)}, ref ${ref}).`,
    );
  }

  async function select(ref: number, value: string, opts: ActionOptions = {}): Promise<ActionResult> {
    const resolution = registry.resolve(ref);
    if (!resolution.ok) return staleRefResult(ref, resolution.reason);
    const element = resolution.element;

    if (!isSelectElement(element)) {
      return fail(
        `Ref ${ref} is not a <select>.`,
        `Ref ${ref} is a "${deriveRole(element)}" element, not a select. Take a new snapshot() and choose a combobox.`,
      );
    }

    const name = labelFor(element);
    const option = Array.from(element.options).find(
      (candidate) => candidate.value === value || (candidate.textContent ?? '').trim() === value,
    );
    if (!option) {
      const available = Array.from(element.options)
        .map((candidate) => candidate.value || (candidate.textContent ?? '').trim())
        .filter(Boolean);
      return fail(
        `No option "${value}" in "${name}".`,
        `"${name}" has no option with value "${value}". Available options: ${available.join(', ')}.`,
      );
    }

    const optionLabel = (option.textContent ?? '').trim() || option.value;
    const outcome = evaluateGate({
      tool: ACTION_TOOL.select,
      args: { ref, field: name, value: option.value },
      context: policyContext(),
      approved: opts.approved === true,
      summary: `Select "${optionLabel}" in "${name}" (ref ${ref})`,
    });
    if (!outcome.allowed) return outcome.blocked;

    element.value = option.value;
    dispatch(element, 'input');
    dispatch(element, 'change');
    return ok(`Selected "${optionLabel}" in "${name}" (combobox, ref ${ref}).`);
  }

  async function pressKey(key: string, opts: ActionOptions = {}): Promise<ActionResult> {
    const active = activeElement();

    if (isSubmitKey(key, active)) {
      const name = isHtmlElement(active) ? labelFor(active) : 'the active field';
      return submitRefusal(
        { key, on: name },
        policyContext(),
        `Refused to press ${key} on "${name}" — it would submit.`,
      );
    }

    const outcome = evaluateGate({
      tool: ACTION_TOOL.pressKey,
      args: { key },
      context: policyContext(),
      approved: opts.approved === true,
      summary: `Press "${key}"`,
    });
    if (!outcome.allowed) return outcome.blocked;

    const target = isHtmlElement(active) ? active : null;
    const eventTarget = target ?? (typeof document !== 'undefined' ? document.body : null);
    if (eventTarget) {
      dispatchKey(eventTarget, 'keydown', key);
      dispatchKey(eventTarget, 'keyup', key);
    }
    return ok(`Pressed ${key}${target ? ` on "${labelFor(target)}"` : ''}.`);
  }

  async function scroll(input: ScrollInput, opts: ActionOptions = {}): Promise<ActionResult> {
    const { dx, dy, label } = parseScroll(input);
    const outcome = evaluateGate({
      tool: ACTION_TOOL.scroll,
      args: { direction: label },
      context: policyContext(),
      approved: opts.approved === true,
      summary: `Scroll ${label}`,
    });
    if (!outcome.allowed) return outcome.blocked;

    if (hooks.scrollBy) {
      await hooks.scrollBy(dx, dy);
    } else {
      const w = win();
      if (w && typeof w.scrollBy === 'function') {
        try {
          w.scrollBy(dx, dy);
        } catch {
          // jsdom has no layout; scrolling is a no-op there.
        }
      }
    }
    return ok(`Scrolled ${label}.`);
  }

  async function waitFor(input: WaitInput, opts: ActionOptions = {}): Promise<ActionResult> {
    const spec = normalizeWait(input, defaultTimeout);
    const outcome = evaluateGate({
      tool: ACTION_TOOL.waitFor,
      args: { target: spec.label },
      context: policyContext(),
      approved: opts.approved === true,
      summary: `Wait for ${spec.label}`,
    });
    if (!outcome.allowed) return outcome.blocked;

    const start = now();
    if (spec.ms !== undefined) {
      if (spec.ms > 0) await sleep(spec.ms);
      return ok(`Waited ${spec.ms}ms.`);
    }

    const deadline = start + spec.timeoutMs;
    for (;;) {
      if (waitMatched(spec)) {
        const elapsed = Math.max(0, Math.round(now() - start));
        return ok(`${capitalize(spec.label)} appeared after ${elapsed}ms.`);
      }
      if (now() >= deadline) {
        return fail(
          `Timed out waiting for ${spec.label}.`,
          `Waited ${spec.timeoutMs}ms for ${spec.label} but it never appeared.`,
        );
      }
      await sleep(WAIT_POLL_MS);
    }
  }

  function waitMatched(spec: WaitSpec): boolean {
    if (typeof document === 'undefined') return false;
    if (spec.selector) {
      try {
        return document.querySelector(spec.selector) !== null;
      } catch {
        return false;
      }
    }
    if (spec.text) return (document.body?.textContent ?? '').includes(spec.text);
    return true;
  }

  async function navigate(url: string, opts: ActionOptions = {}): Promise<ActionResult> {
    const target = typeof url === 'string' ? url.trim() : '';
    if (!target) return fail('Nothing to navigate to.', 'navigate() needs a non-empty URL string.');

    const outcome = evaluateGate({
      tool: ACTION_TOOL.navigate,
      args: { url: target },
      context: policyContext(),
      approved: opts.approved === true,
      summary: `Navigate to ${target}`,
    });
    if (!outcome.allowed) return outcome.blocked;

    if (hooks.navigate) {
      await hooks.navigate(target);
    } else if (typeof location !== 'undefined') {
      try {
        location.assign(target);
      } catch {
        try {
          location.href = target;
        } catch {
          // No navigation available (jsdom without hooks) — the summary still stands.
        }
      }
    }
    return ok(`Navigating to ${target}.`);
  }

  async function goBack(opts: ActionOptions = {}): Promise<ActionResult> {
    const outcome = evaluateGate({
      tool: ACTION_TOOL.goBack,
      args: {},
      context: policyContext(),
      approved: opts.approved === true,
      summary: 'Go back',
    });
    if (!outcome.allowed) return outcome.blocked;

    if (hooks.goBack) {
      await hooks.goBack();
    } else if (typeof history !== 'undefined') {
      try {
        history.back();
      } catch {
        // ignore: jsdom/browsers without a history
      }
    }
    return ok('Went back to the previous page.');
  }

  return {
    snapshot,
    click,
    type,
    select,
    pressKey,
    scroll,
    waitFor,
    navigate,
    goBack,
    registry,
    input,
  };
}
