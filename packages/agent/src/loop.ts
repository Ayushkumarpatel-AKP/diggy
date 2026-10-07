/**
 * Loop detection.
 *
 * A run gets stuck when it keeps choosing the *same* tool call against the
 * *same* page. We watch the triple `toolName + args + pageSignature`: the third
 * identical action (and not the first or second) aborts the run with a human
 * explanation. Nothing here can throw — a cyclic argument becomes
 * `"[circular]"`, an unserialisable one becomes `"[unserializable]"`.
 */
import type { PendingAction } from './types';

/** How many identical actions before we call it a loop. */
export const DEFAULT_LOOP_THRESHOLD = 3;

/** Deterministic JSON with sorted keys, cycle-safe and total. */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  const walk = (input: unknown): unknown => {
    if (input === null) return null;
    const type = typeof input;
    if (type !== 'object') {
      if (type === 'undefined') return '[undefined]';
      if (type === 'function') return '[function]';
      if (type === 'bigint') return `[bigint:${String(input)}]`;
      if (type === 'symbol') return '[symbol]';
      return input;
    }
    const object = input as object;
    if (seen.has(object)) return '[circular]';
    seen.add(object);
    if (Array.isArray(input)) return input.map(walk);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input as Record<string, unknown>).sort()) {
      out[key] = walk((input as Record<string, unknown>)[key]);
    }
    return out;
  };

  try {
    return JSON.stringify(walk(value)) ?? 'null';
  } catch {
    return '[unserializable]';
  }
}

/** The stable identity of an action, for counting repeats. */
export function actionSignature(action: PendingAction | null | undefined): string {
  if (!action || typeof action !== 'object') return 'none::null::';
  const tool =
    typeof action.toolName === 'string' && action.toolName.length > 0 ? action.toolName : 'unknown';
  const page = typeof action.pageSignature === 'string' ? action.pageSignature : '';
  return `${tool}::${stableStringify(action.args)}::${page}`;
}

export interface LoopVerdict {
  looped: boolean;
  /** How many times this exact signature has now been seen in the run. */
  count: number;
  threshold: number;
  signature: string;
}

/**
 * Counts occurrences of each action signature across a run and reports when one
 * reaches the threshold. Counting *total* occurrences (not just consecutive
 * ones) also catches an A/B/A/B/A/B ping-pong.
 */
export class LoopDetector {
  private readonly counts = new Map<string, number>();
  private readonly threshold: number;

  constructor(threshold: number = DEFAULT_LOOP_THRESHOLD) {
    this.threshold =
      typeof threshold === 'number' && Number.isFinite(threshold) && threshold > 0
        ? Math.floor(threshold)
        : DEFAULT_LOOP_THRESHOLD;
  }

  record(signature: string): LoopVerdict {
    const key = typeof signature === 'string' && signature ? signature : 'none::null::';
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return { looped: count >= this.threshold, count, threshold: this.threshold, signature: key };
  }

  reset(): void {
    this.counts.clear();
  }
}

/** A one-line, human explanation of why the run was stopped. */
export function loopExplanation(action: PendingAction | null | undefined, count: number): string {
  const tool =
    action && typeof action.toolName === 'string' && action.toolName ? action.toolName : 'the same tool';
  const page =
    action && typeof action.pageSignature === 'string' && action.pageSignature
      ? ` on ${action.pageSignature}`
      : '';
  return `Stopped: it repeated the same action ${count} times (${tool}${page}). It looks stuck in a loop — try rephrasing the request or narrowing the goal.`;
}
