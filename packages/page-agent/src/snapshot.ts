/**
 * The snapshot — the agent's "eyes" for the act layer.
 *
 * Returns a compact, capped list of the **visible, interactive** elements on the
 * page: buttons, links, inputs, selects, tabs, menus and anything carrying a
 * usable ARIA role. Each entry gets an incrementing numeric `ref`, an accessible
 * name, its role/type, its current value (redacted when secret-bearing), a
 * bounding box and an `inViewport` flag.
 *
 * ## Coverage
 * Open shadow roots and same-origin iframes are traversed (querySelectorAll does
 * not pierce either), to a bounded depth. Cross-origin iframes are skipped — the
 * browser would not let us read them anyway.
 *
 * ## The cap
 * The output is hard-capped at {@link MAX_SNAPSHOT_ENTRIES} (default 100).
 * When more candidates exist, what is dropped **first** is:
 *  1. **non-interactive elements** — never collected at all (an inert `<div>`,
 *     layout wrappers, decorative markup); and
 *  2. **off-screen candidates** — every in-viewport element is kept before any
 *     off-screen one is. An off-screen element is only included if the cap has
 *     room left after all on-screen elements.
 * `PageSnapshot.truncated` / `.droppedOffscreen` report whether/how much the cap
 * discarded.
 */
import {
  accessibleName,
  bboxOf,
  controlType,
  deriveRole,
  documentOf,
  isIframeElement,
  isInViewport,
  isInteractiveElement,
  valueFor,
} from './dom';
import type { RefRegistry } from './ref-registry';
import type { PageSnapshot, SnapshotEntry, SnapshotOptions } from './types';

/**
 * The hard cap on how many entries a snapshot returns. Chosen so the list stays
 * a usable prompt size (~100 lines) even on a dense page, while covering a
 * typical screen's worth of controls.
 */
export const MAX_SNAPSHOT_ENTRIES = 100;

/** How deep to follow shadow hosts / iframes (guards pathological nesting). */
const MAX_TRAVERSAL_DEPTH = 10;

/** Collect interactive elements under `scope`, descending into shadow roots and same-origin iframes. */
function collectCandidates(
  scope: ParentNode,
  out: HTMLElement[],
  seen: Set<Node>,
  depth: number,
): void {
  if (depth > MAX_TRAVERSAL_DEPTH) return;

  for (const node of Array.from(scope.querySelectorAll('*'))) {
    if (seen.has(node)) continue;
    seen.add(node);

    if (isInteractiveElement(node)) out.push(node);

    // querySelectorAll does not cross these boundaries, so recurse by hand.
    const shadow = node.shadowRoot;
    if (shadow) collectCandidates(shadow, out, seen, depth + 1);

    if (isIframeElement(node)) {
      let doc: Document | null = null;
      try {
        doc = node.contentDocument; // null for cross-origin frames
      } catch {
        doc = null;
      }
      if (doc && !seen.has(doc)) {
        seen.add(doc);
        collectCandidates(doc, out, seen, depth + 1);
      }
    }
  }
}

function describeEntry(el: HTMLElement, ref: number, inViewport: boolean): SnapshotEntry {
  const entry: SnapshotEntry = {
    ref,
    role: deriveRole(el),
    name: accessibleName(el),
    bbox: bboxOf(el),
    inViewport,
  };
  const type = controlType(el);
  if (type !== undefined) entry.type = type;
  const { value } = valueFor(el);
  if (value !== undefined) entry.value = value;
  return entry;
}

/**
 * Build a snapshot against an existing ref registry (so the refs it returns can
 * later be resolved by the same agent). Prefer {@link PageAgent.snapshot} /
 * `snapshot()`; this is the shared implementation.
 */
export function buildSnapshot(registry: RefRegistry, options: SnapshotOptions = {}): PageSnapshot {
  const root: ParentNode | null =
    options.root ?? (typeof document !== 'undefined' ? document : null);
  const doc = root ? documentOf(root) : null;

  if (!root) {
    return { url: '', title: '', entries: [], total: 0, truncated: false, droppedOffscreen: 0 };
  }

  const candidates: HTMLElement[] = [];
  collectCandidates(root, candidates, new Set<Node>(), 0);

  const onScreen: HTMLElement[] = [];
  const offScreen: HTMLElement[] = [];
  for (const el of candidates) {
    if (isInViewport(el, options.viewport)) onScreen.push(el);
    else offScreen.push(el);
  }

  const ordered = [...onScreen, ...offScreen];
  const max = Math.max(0, options.max ?? MAX_SNAPSHOT_ENTRIES);
  const kept = ordered.slice(0, max);

  const generation = registry.beginSnapshot();
  const entries = kept.map((el) => describeEntry(el, registry.register(el, generation), onScreen.includes(el)));

  const includedOffscreen = entries.reduce((count, entry) => (entry.inViewport ? count : count + 1), 0);

  return {
    url: doc?.location?.href ?? (typeof location !== 'undefined' ? location.href : ''),
    title: doc?.title ?? '',
    entries,
    total: candidates.length,
    truncated: ordered.length > max,
    droppedOffscreen: offScreen.length - includedOffscreen,
  };
}
