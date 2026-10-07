/**
 * The run budget: how far a single run may go before it parks itself.
 *
 * A budgeted stop is never a failure — it writes a checkpoint first, so the
 * next worker wake resumes from exactly where it left off. This is what makes
 * an MV3 service worker's ~30-second lifetime survivable.
 */
import { toNonNegativeInt } from './numbers';

/** Default step budget: a run may execute at most this many steps in total. */
export const DEFAULT_MAX_STEPS = 20;

/** Default wall-clock limit: how long a single run may take before parking. */
export const DEFAULT_WALL_CLOCK_MS = 2 * 60 * 1000;

export interface Budget {
  maxSteps: number;
  wallClockMs: number;
}

export interface BudgetOverrides {
  maxSteps?: number;
  wallClockMs?: number;
}

/** Normalise a caller-supplied budget, falling back to the documented defaults. */
export function resolveBudget(
  overrides?: BudgetOverrides,
  defaults: Budget = { maxSteps: DEFAULT_MAX_STEPS, wallClockMs: DEFAULT_WALL_CLOCK_MS },
): Budget {
  const source = overrides && typeof overrides === 'object' ? overrides : {};
  return {
    maxSteps: toNonNegativeInt(source.maxSteps, defaults.maxSteps),
    wallClockMs: toNonNegativeInt(source.wallClockMs, defaults.wallClockMs),
  };
}
