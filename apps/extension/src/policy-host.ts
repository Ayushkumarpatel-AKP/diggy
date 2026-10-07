/**
 * policy-host — the glue between `PlatformToolContext` and `@diggy/policy`.
 *
 * The policy package is deliberately pure and host-free: it knows how to
 * *classify* a tool and *decide* whether a call may run, but it does not know
 * about `browser.storage`, rich cards or the extension's settings shape. This
 * module adapts the extension's world to it:
 *
 * - {@link RunContext} is a long-lived, per-run handle that owns the taint state
 *   and the sensitive-site allow list (read from settings), and is the single
 *   place `PlatformToolContext` asks "may this tool call run?".
 * - {@link RunContext.guardToolCall} returns the package's `allow | confirm |
 *   deny` decision plus a human-readable reason.
 * - {@link RunContext.markUntrustedRead} is called after every read that pulls
 *   third-party content into the turn (`readPage`, `crawl`, `searchWeb`,
 *   `readTranscript`, `readInbox`, `readCalendar`, and reads from the user's own
 *   signed-in tab): from then on, every outward-effect tool must confirm.
 * - {@link policyConfirmCard} / {@link policyDenyCard} render the decision as a
 *   `RichCard` the side panel already knows how to draw.
 *
 * Nothing here weakens the product's hard rules (never auto-submit, never
 * auto-fill secrets); those live in the prompt and `PlatformToolContext`.
 */
import type { RichCard } from '@diggy/shared';
// NOTE: imported by path, not by name. `@diggy/policy` is not yet declared in
// `apps/extension/package.json`, so a bare specifier does not resolve here; the
// path import keeps typecheck/build green without adding a dependency. Once the
// coordinator adds `"@diggy/policy": "workspace:*"` and runs `pnpm install`,
// this (and `packages/core/src/prompt.ts`) can switch back to `@diggy/policy`.
import {
  decide,
  getTaintState,
  isSensitiveSite,
  markUntrusted,
  resetTaint,
  wrapUntrusted,
  type DecideResult,
  type TaintState,
  type ToolClass,
} from '../../../packages/policy/src/index';
import { getSettings } from './storage';

export type { DecideResult, TaintState } from '../../../packages/policy/src/index';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** How long an approved confirmation stays usable, in milliseconds. */
const APPROVAL_TTL_MS = 5 * 60 * 1000;

/** Cap on the redacted payload preview shown in a confirm card. */
const MAX_PREVIEW = 600;

/** Command prefixes the side panel uses to answer a confirmation card. */
export const POLICY_CONFIRM_PREFIX = 'policy:confirm:';
export const POLICY_CANCEL_PREFIX = 'policy:cancel:';

/* ------------------------------------------------------------------ *
 * Settings adaptation
 * ------------------------------------------------------------------ */

/** The slice of `Settings` the policy layer reads. */
export interface PolicySettings {
  /** Hosts (or URLs) the user has approved for sensitive-site actions. */
  sensitiveSiteAllowlist: readonly string[];
}

/** Coerce a stored allow list into a clean `string[]` (never throws). */
function normalizeAllowlist(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
}

/**
 * Project the extension's {@link Settings} onto what the policy layer needs.
 *
 * A missing or malformed allow list reads as empty — the safe default keeps
 * every sensitive site blocked.
 */
export function policySettingsFrom(
  settings: { sensitiveSiteAllowlist?: unknown } | null | undefined,
): PolicySettings {
  return { sensitiveSiteAllowlist: normalizeAllowlist(settings?.sensitiveSiteAllowlist) };
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function newToken(): string {
  const globalCrypto = globalThis.crypto as Crypto | undefined;
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function cardId(prefix: string): string {
  return `${prefix}-${newToken().slice(0, 12)}`;
}

function coerceText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '';
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** Stable key for "this exact tool with these exact arguments". */
function argsKey(tool: string, args: unknown): string {
  return `${tool}|${coerceText(args)}`;
}

/* ------------------------------------------------------------------ *
 * RunContext
 * ------------------------------------------------------------------ */

/** A confirmation the user has not answered yet. */
export interface PendingConfirmation {
  token: string;
  tool: string;
  /** The model's original arguments (replayed after approval). */
  params: unknown;
  /** The arguments the guard actually saw (may carry an injected page URL). */
  guardArgs: unknown;
  decision: DecideResult;
  requestedAt: number;
}

export interface RunContextOptions {
  /** Seed the allow list directly instead of reading it from settings. */
  sensitiveSiteAllowlist?: readonly string[];
  /** Read the allow list from storage on first use. Default `true`. */
  autoHydrate?: boolean;
}

/**
 * Owns the per-run policy state for one `PlatformToolContext`.
 *
 * Taint lives in the `@diggy/policy` module, which is process-wide; the
 * `RunContext` is the handle the host holds onto for the life of a run and
 * mirrors it ({@link tainted}), plus the sensitive-site allow list and any
 * pending confirmations.
 */
export class RunContext {
  private allowlist: readonly string[] = [];
  private hydrated = false;
  private hydrating: Promise<void> | null = null;
  private readonly autoHydrate: boolean;
  private readonly pending = new Map<string, PendingConfirmation>();
  private readonly grants = new Map<string, { expiresAt: number; category: ToolClass }>();

  constructor(options: RunContextOptions = {}) {
    this.autoHydrate = options.autoHydrate ?? true;
    if (options.sensitiveSiteAllowlist !== undefined) {
      this.allowlist = normalizeAllowlist(options.sensitiveSiteAllowlist);
      this.hydrated = true;
    }
  }

  /** Replace the allow list (call when settings change). */
  applySettings(settings: PolicySettings | { sensitiveSiteAllowlist?: unknown } | null | undefined): void {
    this.allowlist = policySettingsFrom(settings).sensitiveSiteAllowlist;
    this.hydrated = true;
    // A changed allow list invalidates any outstanding approvals.
    this.grants.clear();
    this.pending.clear();
  }

  /** Re-read the allow list from `chrome.storage`. */
  async hydrate(): Promise<void> {
    this.applySettings(policySettingsFrom(await getSettings()));
  }

  private async ensure(): Promise<void> {
    if (this.hydrated || !this.autoHydrate) return;
    if (!this.hydrating) {
      // A storage failure must not crash a tool call — fall back to "empty
      // allow list" (the safe default) and keep going.
      this.hydrating = this.hydrate().catch(() => {
        this.hydrated = true;
      });
    }
    await this.hydrating;
  }

  /** Start a fresh, trusted turn: clear all taint. */
  beginRun(): void {
    resetTaint();
    this.grants.clear();
  }

  get sensitiveSiteAllowlist(): readonly string[] {
    return this.allowlist;
  }

  get taintState(): TaintState {
    return getTaintState();
  }

  get tainted(): boolean {
    return getTaintState().tainted;
  }

  /** Is this URL a sensitive site the user has NOT allow-listed? */
  isSensitive(url: unknown): boolean {
    return isSensitiveSite(url, { allowlist: this.allowlist });
  }

  /**
   * Decide whether a tool call may run.
   *
   * A call the user just approved (see {@link approve}) is allowed for exactly
   * one more invocation of the same tool + arguments. Everything else is handed
   * to `@diggy/policy`'s {@link decide}: unknown tools and sensitive sites are
   * denied, irreversible actions always confirm, and any outward-effect tool
   * confirms while the run is tainted.
   */
  async guardToolCall(tool: string, args?: unknown): Promise<DecideResult> {
    await this.ensure();
    const grant = this.takeGrant(tool, args);
    if (grant) {
      return {
        decision: 'allow',
        category: grant,
        reason: `Allowed: "${tool}" was confirmed by the user.`,
      };
    }
    return decide(tool, args, { siteAllowlist: this.allowlist });
  }

  /**
   * Record that a read returned third-party content.
   *
   * Marks the run tainted (so outward effects must confirm) and returns the text
   * fenced as untrusted DATA so the model reads it as information, never as
   * instructions. `result` is only consulted when `text` is empty.
   */
  markUntrustedRead(source: string, text: unknown, result?: unknown): string {
    const primary = coerceText(text);
    const body = primary.trim().length > 0 ? primary : coerceText(result);
    markUntrusted(source, body);
    return wrapUntrusted(source, body);
  }

  /**
   * Remember a `confirm` decision and return the card that asks the user.
   *
   * The card carries the exact tool, destination and redacted payload; nothing
   * is executed until the user answers (see {@link approve}).
   */
  confirmationCard(tool: string, params: unknown, guardArgs: unknown, decision: DecideResult): RichCard {
    const token = newToken();
    const pending: PendingConfirmation = {
      token,
      tool,
      params,
      guardArgs,
      decision,
      requestedAt: Date.now(),
    };
    this.pending.set(token, pending);
    this.prune();
    return policyConfirmCard(pending);
  }

  /** The user approved a confirmation: grant a one-shot allowance. */
  approve(token: string): PendingConfirmation | undefined {
    const pending = this.pending.get(token);
    if (!pending) return undefined;
    this.pending.delete(token);
    this.grants.set(argsKey(pending.tool, pending.guardArgs), {
      expiresAt: Date.now() + APPROVAL_TTL_MS,
      category: pending.decision.category,
    });
    return pending;
  }

  /** The user cancelled a confirmation. */
  cancel(token: string): boolean {
    return this.pending.delete(token);
  }

  private takeGrant(tool: string, args: unknown): ToolClass | null {
    const key = argsKey(tool, args);
    const grant = this.grants.get(key);
    if (grant === undefined) return null;
    this.grants.delete(key); // one-shot
    if (grant.expiresAt <= Date.now()) return null;
    return grant.category;
  }

  /** Drop stale pending confirmations and expired grants. */
  private prune(): void {
    const now = Date.now();
    for (const [token, entry] of this.pending) {
      if (now - entry.requestedAt > APPROVAL_TTL_MS) this.pending.delete(token);
    }
    for (const [key, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(key);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Cards
 * ------------------------------------------------------------------ */

/** The `policy:confirm:<token>` / `policy:cancel:<token>` a card button sends. */
export interface PolicyCommand {
  action: 'confirm' | 'cancel';
  token: string;
}

/** Parse a card action value into a policy command, or `null` if it is not one. */
export function parsePolicyCommand(value: unknown): PolicyCommand | null {
  if (typeof value !== 'string') return null;
  if (value.startsWith(POLICY_CONFIRM_PREFIX)) {
    const token = value.slice(POLICY_CONFIRM_PREFIX.length).trim();
    return token ? { action: 'confirm', token } : null;
  }
  if (value.startsWith(POLICY_CANCEL_PREFIX)) {
    const token = value.slice(POLICY_CANCEL_PREFIX.length).trim();
    return token ? { action: 'cancel', token } : null;
  }
  return null;
}

/**
 * A human label for what a gated call would act on.
 *
 * Prefers the destination URL the policy resolved from the arguments; falls back
 * to a tool-appropriate description when the tool has no page target.
 */
function destinationFor(pending: PendingConfirmation): string {
  const site = pending.decision.confirmPayload?.site;
  if (typeof site === 'string' && site.trim() !== '') return site;
  switch (pending.tool) {
    case 'createReminder':
      return 'your reminders';
    case 'notify':
      return 'a desktop notification';
    case 'getProfile':
      return 'your local vault profile';
    default:
      return 'the page you are on';
  }
}

/**
 * The confirmation card.
 *
 * Shows the exact tool, its destination (the target site, or a tool-appropriate
 * label) and the redacted payload, and offers Confirm / Cancel. It never performs
 * the action itself.
 */
export function policyConfirmCard(pending: PendingConfirmation): RichCard {
  const payload = pending.decision.confirmPayload;
  const destination = destinationFor(pending);
  const preview = truncate(payload?.preview ?? '', MAX_PREVIEW);
  const details: { label: string; value: string }[] = [
    { label: 'Tool', value: pending.tool },
    { label: 'Destination', value: destination },
    { label: 'Payload', value: preview || '(no arguments)' },
  ];
  if (payload && payload.reasons.length > 0) {
    details.push({ label: 'Why', value: payload.reasons.join('; ') });
  }
  if (pending.decision.category === 'irreversible') {
    details.push({ label: 'Note', value: 'This action cannot be undone.' });
  }
  return {
    id: cardId('policy-confirm'),
    kind: 'generic',
    title: payload?.title ?? `Confirm: ${pending.tool}`,
    subtitle: 'Nothing has happened yet — Diggy only proceeds if you confirm.',
    badge: 'confirmation required',
    details,
    actions: [
      {
        id: 'confirm',
        label: 'Confirm',
        kind: 'command',
        value: `${POLICY_CONFIRM_PREFIX}${pending.token}`,
        variant: 'primary',
      },
      {
        id: 'cancel',
        label: 'Cancel',
        kind: 'command',
        value: `${POLICY_CANCEL_PREFIX}${pending.token}`,
        variant: 'ghost',
      },
    ],
  };
}

/** The refusal card shown when a call is denied (no side effect occurs). */
export function policyDenyCard(tool: string, decision: DecideResult): RichCard {
  return {
    id: cardId('policy-deny'),
    kind: 'generic',
    title: `Blocked: ${tool}`,
    subtitle: decision.reason,
    badge: 'policy denied',
    details: [
      { label: 'Tool', value: tool },
      { label: 'Class', value: decision.category },
    ],
  };
}
