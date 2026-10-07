/**
 * Internal numeric coercion helpers. Kept out of the public API: they only
 * exist so every public function can accept garbage without throwing.
 */

/** A finite integer > 0, or `fallback`. */
export function toPositiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/** A finite integer >= 0, or `fallback`. */
export function toNonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}
