/**
 * Shared jsdom helpers for the page-agent tests. No browser, no network.
 */
import type { PageSnapshot, SnapshotEntry } from '../src/index';

/** Replace the document body with `html`. */
export function setBody(html: string): void {
  document.body.innerHTML = html;
}

/**
 * Give an element a deterministic bounding box. jsdom has no layout engine, so
 * every real rect is `0,0,0,0`; anything that needs `inViewport` to mean
 * something must stub this.
 */
export function stubRect(
  el: Element,
  rect: { x?: number; y?: number; width?: number; height?: number },
): void {
  const x = rect.x ?? 0;
  const y = rect.y ?? 0;
  const width = rect.width ?? 100;
  const height = rect.height ?? 20;
  const box = {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect;
  el.getBoundingClientRect = () => box;
}

/** Find a snapshot entry by its accessible name. */
export function byName(snap: PageSnapshot, name: string): SnapshotEntry | undefined {
  return snap.entries.find((entry) => entry.name === name);
}

/** The ref of the entry named `name`, or a helpful error. */
export function refFor(snap: PageSnapshot, name: string): number {
  const entry = byName(snap, name);
  if (!entry) {
    const available = snap.entries.map((e) => `"${e.name}"`).join(', ');
    throw new Error(`no snapshot entry named "${name}" (entries: ${available || 'none'})`);
  }
  return entry.ref;
}
