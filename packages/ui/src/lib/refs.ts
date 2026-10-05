import type { Ref, RefCallback } from 'react';

/** Assign a DOM node to a React ref of any flavour (callback, object, or nullish). */
export function assignRef<T>(ref: Ref<T> | null | undefined, value: T | null): void {
  if (!ref) return;
  if (typeof ref === 'function') {
    ref(value);
    return;
  }
  (ref as { current: T | null }).current = value;
}

/**
 * Combine several refs (typically an external `forwardRef` and an internal
 * measurement ref) into a single callback ref.
 */
export function mergeRefs<T>(...refs: Array<Ref<T> | null | undefined>): RefCallback<T> {
  return (value: T | null) => {
    for (const ref of refs) assignRef(ref, value);
  };
}
