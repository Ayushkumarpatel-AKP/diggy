/**
 * @diggy/core — runtime tuning constants.
 *
 * ONE HOME RULE: every magic number (a clamp envelope, a particle budget, a
 * retry window, a network timeout, …) lives here and nowhere else — never
 * inlined at a call site. Change a value here and every consumer follows.
 *
 * This module is deliberately dependency-free: plain numbers and one string,
 * no DOM, no `three`, no browser — so it imports safely in the extension
 * service worker, the desktop brain, the crawler and Node tests alike.
 *
 * Each group names the module it was harvested from, so a value can always be
 * traced back to its owner.
 */

/**
 * Root-motion clamp envelope for animation clips (avatar-engine.ts).
 *
 * Clip root motion is intentionally clamped: a dance should read as movement,
 * but must never walk the model out of the camera frame. `turn` is a full
 * rotation and is measured in radians.
 */
export const CLIP_ROOT_LIMITS = Object.freeze({
  x: 0.18,
  y: 0.12,
  z: 0.12,
  bob: 0.08,
  turn: Math.PI * 2,
});

/** Procedural walk cycle (avatar-engine.ts `WALK`). */
export const WALK = Object.freeze({
  /** Angular speed of the walk phase (rad/s). Natural cadence ≈ 6 rad/s. */
  cadence: 6.2,
  /** Body turn toward the travel direction (rad) — a side-profile walk. */
  yaw: 1.45,
  /** Approximate walking speed in metres/second (drives clip duration). */
  speed: 0.55,
  /** Vertical bob amplitude (metres). */
  bob: 0.012,
});

/** Sparkle "magic dust" particle field (particles.ts). */
export const SPARKLES = Object.freeze({
  count: 140,
  size: 0.075,
  lifeMs: 1800,
  spread: 0.46,
  rise: 0.7,
  /** High-contrast palette: saturated magenta / violet / gold / cyan. */
  palette: [0xff1f8f, 0x7c3aed, 0xffc400, 0x00d5ff],
});

/**
 * Brain resilience.
 *
 * `providerExhaustMs` and `emptyReplyNudge` come from brain.ts. brain.ts's own
 * empty-reply nudge loop runs `retryAttempts` times; the `retryDelayMs` is the
 * shared send retry delay used by the extension's message layer (messages.ts).
 */
export const BRAIN = Object.freeze({
  /** How long an exhausted provider is skipped before it is tried again. */
  providerExhaustMs: 300_000,
  /** Attempts per provider for the empty-reply nudge loop (brain.ts). */
  retryAttempts: 2,
  /** Delay between message send retries (messages.ts). */
  retryDelayMs: 250,
  /** Nudge appended to force a visible answer from a reasoning model. */
  emptyReplyNudge: 'Reply now with one short sentence.',
});

/** Reminder scheduling fallbacks (platform-context.ts). */
export const REMINDERS = Object.freeze({
  /** Unparsable due date → schedule this far out. */
  fallbackDelayMs: 600_000,
  /** Already-past due date → pull it forward by this much. */
  pastDelayMs: 60_000,
});

/** YouTube card lookups (cards/youtube.ts). */
export const YOUTUBE = Object.freeze({
  /** Per-request fetch timeout. */
  fetchTimeoutMs: 30_000,
  /** Number of search phrasings run when the feed/page has no video. */
  searchQueries: 5,
  /** How many ranked candidates are pooled per search query. */
  maxCandidates: 10,
});

/** Web search (services/crawler/src/search.ts). */
export const SEARCH = Object.freeze({
  /** Per-request fetch timeout. */
  timeoutMs: 10_000,
  /** Maximum results returned. */
  maxResults: 10,
});
