/**
 * Internal (non-exported-from-index) types shared between modules.
 */

/** Why a ref could not be resolved. See `ref-registry.ts`. */
export type StaleReason = 'unknown' | 'gone' | 'replaced';

/** The outcome of `RefRegistry.resolve`. */
export type RefResolution =
  | { ok: true; element: HTMLElement }
  | { ok: false; reason: StaleReason };
