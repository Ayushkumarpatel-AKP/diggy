/**
 * Ref bookkeeping — the mechanism behind "never act on a wrong element".
 *
 * A snapshot hands out incrementing numeric refs and stamps each element with
 * {@link REF_ATTRIBUTE} = `"<generation>:<ref>"`. `resolve()` only succeeds when
 * the ref is known **and** the element is still connected **and** still carries
 * that exact token. Anything else is *stale*:
 *
 * - `unknown`  — the ref was never handed out (invented / from another run).
 * - `gone`     — the element is detached from the document.
 * - `replaced` — a different node now occupies that ref (re-render, or a newer
 *   snapshot reused the ref number), which is exactly when acting would be a
 *   mistake.
 */
import type { RefResolution } from './types-internal';

/** The attribute a registered element carries so its identity can be checked. */
export const REF_ATTRIBUTE = 'data-diggy-ref';

interface RegisteredRef {
  element: HTMLElement;
  token: string;
}

/**
 * Holds the `ref → element` mapping for one page-agent. Refs are unique and
 * monotonically increasing across snapshots; a later snapshot does not delete an
 * earlier ref, but re-stamping an element invalidates the earlier one (it now
 * resolves as `replaced`).
 */
export class RefRegistry {
  private counter = 0;
  private generation = 0;
  private readonly refs = new Map<number, RegisteredRef>();

  /** Start a snapshot; returns its generation token. */
  beginSnapshot(): number {
    this.generation += 1;
    return this.generation;
  }

  /** Assign the next ref to an element and stamp it with `generation:ref`. */
  register(element: HTMLElement, generation: number): number {
    this.counter += 1;
    const ref = this.counter;
    const token = `${generation}:${ref}`;
    element.setAttribute(REF_ATTRIBUTE, token);
    this.refs.set(ref, { element, token });
    return ref;
  }

  /** Resolve a ref, or explain why it is stale. Never returns a wrong element. */
  resolve(ref: number): RefResolution {
    const entry = this.refs.get(ref);
    if (!entry) return { ok: false, reason: 'unknown' };
    const { element, token } = entry;
    if (!element.isConnected) return { ok: false, reason: 'gone' };
    if (element.getAttribute(REF_ATTRIBUTE) !== token) return { ok: false, reason: 'replaced' };
    return { ok: true, element };
  }

  /** How many refs have been handed out (diagnostics/tests). */
  size(): number {
    return this.refs.size;
  }

  /** Forget every ref (a navigation invalidates the page). */
  clear(): void {
    this.refs.clear();
  }
}
