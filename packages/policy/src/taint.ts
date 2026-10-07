/**
 * Taint tracking.
 *
 * The moment any untrusted content enters the working context — a web page, a
 * transcript, a signed-in tab read, a plugin result — the session is *tainted*.
 * While tainted, every outward-effect tool must be confirmed, never allowed.
 *
 * Taint is a process-wide flag with a small audit trail of *sources* (labels and
 * lengths), never the content itself. Nothing here throws on garbage input.
 */
import type { ContentOrigin, PolicyContext, TaintSource, TaintState } from './types';

const UNTAINTED: TaintState = Object.freeze({
  tainted: false,
  sources: Object.freeze([]) as readonly TaintSource[],
  lastUpdated: null,
});

/** Keep the audit trail bounded — this is a signal, not a log. */
const MAX_SOURCES = 64;

let current: TaintState = UNTAINTED;

/** Coerce arbitrary text into a string without ever throwing. */
function coerceText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json : '';
  } catch {
    return '';
  }
}

/** Coerce a source label; fall back to a neutral name. */
function coerceSource(source: unknown): string {
  if (typeof source === 'string' && source.trim() !== '') return source.trim();
  if (typeof source === 'number' || typeof source === 'boolean') return String(source);
  return 'unknown';
}

/**
 * Record that untrusted content is now part of the context.
 *
 * @param source short label for where it came from, e.g. `'web page'`,
 *   `'gmail inbox'`, `'plugin:notion'`.
 * @param text the content itself — only its length is retained.
 * @returns the updated {@link TaintState}.
 */
export function markUntrusted(source: unknown, text: unknown): TaintState {
  const label = coerceSource(source);
  const body = coerceText(text);
  const at = Date.now();
  const entry: TaintSource = { source: label, length: body.length, at };
  const sources = [...current.sources, entry].slice(-MAX_SOURCES);
  current = Object.freeze({ tainted: true, sources: Object.freeze(sources), lastUpdated: at });
  return current;
}

/** The current process-wide taint state (read-only snapshot). */
export function getTaintState(): TaintState {
  return current;
}

/** Clear all taint — call at the start of a fresh, trusted turn. */
export function resetTaint(): void {
  current = UNTAINTED;
}

function isTaintState(value: unknown): value is TaintState {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { tainted?: unknown }).tainted === 'boolean'
  );
}

/** Origins that carry third-party text and therefore taint the session. */
export function isUntrustedOrigin(origin: unknown): boolean {
  return origin === 'untrusted' || origin === 'plugin';
}

/**
 * Is the session tainted?
 *
 * True if anything was ever {@link markUntrusted}ed this process, or if the
 * supplied input (a bare boolean, a {@link TaintState}, or a
 * {@link PolicyContext} whose `taint`/`origin` say so) is tainted.
 */
export function isTainted(input?: boolean | TaintState | PolicyContext | null): boolean {
  if (current.tainted) return true;
  if (input === undefined || input === null) return false;
  if (typeof input === 'boolean') return input;
  if (isTaintState(input)) return input.tainted;

  const context = input as PolicyContext;
  if (context.taint === true) return true;
  if (isTaintState(context.taint)) return context.taint.tainted;
  if (isUntrustedOrigin(context.origin)) return true;
  return false;
}

/** Re-exported so callers can type their own taint-aware knobs. */
export type { ContentOrigin, TaintState, TaintSource };
