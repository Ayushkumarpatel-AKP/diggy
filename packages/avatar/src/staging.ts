/**
 * Staging — where the avatar stands, and how it gets there.
 *
 * The engine originally hard-coded the avatar into the bottom-left corner via a
 * single `anchor`. That is fine for a marketing widget but breaks as soon as the
 * host wants the bot elsewhere (a side panel, a centred modal, a watch-along
 * overlay). This module gives the package a first-class vocabulary for that:
 *
 * - {@link Stage} / {@link STAGES} — named, tested placements (position + scale +
 *   camera framing) so a host can say "put it `nearCamera`" instead of juggling
 *   raw anchors and fit fractions that must stay in sync.
 * - {@link StagePath} — a deterministic, frame-rate independent entry/exit path
 *   that the engine samples every frame, mirroring `_startWalk` / `_updateWalk`.
 *
 * Nothing here imports three.js or touches the DOM: it is pure geometry so it can
 * be unit-tested and reused by any renderer.
 *
 * ## Coordinate systems (important)
 * `Stage.x` / `Stage.y` and {@link PathSample}.x / .y are **normalised container
 * coordinates**: `0 = left/bottom edge`, `1 = right/top edge` (y grows upward).
 * The host maps them to world space using the framing the engine computes
 * (`visibleWidth` / `visibleHeight`). `turn` is yaw in radians and `bob` is a
 * vertical offset in **metres**, matching the units the engine already uses for
 * `vrm.scene.position.y`.
 */

// --- Shared types -----------------------------------------------------------

/** Which screen edge the bot walks in from / out to. */
export type Edge = 'left' | 'right' | 'bottom' | 'top';

/**
 * A named position on screen.
 *
 * Position (`x`/`y`), apparent size (`scale`) and camera framing
 * (`fitFraction`/`anchor`) are bundled together on purpose: they are only
 * correct *relative to each other*. Keeping them in one object means the host
 * cannot pick a fit fraction that clips the head off a placement, and the menu
 * UI can be generated straight from these fields.
 */
export interface Stage {
  name: StageName;
  label: string;
  /** 0 = left edge, 1 = right edge of the avatar container */
  x: number;
  /** 0 = bottom, 1 = top */
  y: number;
  /** 0..1 — how much of the container the model fills */
  scale: number;
  /** camera framing to use here */
  fitFraction: number;
  anchor: { x: number; y: number };
}

/**
 * The stages a host may place the avatar in.
 *
 * A small closed union (rather than free-form strings) so placements are
 * exhaustive, discoverable in an IDE, and cheap to switch on — e.g. a settings
 * dropdown or a per-context default.
 */
export type StageName =
  | 'bottomLeft' | 'bottomRight' | 'bottomCenter'
  | 'topLeft' | 'topRight'
  | 'center' | 'centerLeft' | 'centerRight'
  | 'nearCamera' | 'farLeft' | 'farRight';

// --- Tunables ---------------------------------------------------------------

/** Hard cap on a single step so a stalled tab cannot teleport the avatar (50ms). */
const MAX_STEP_SECONDS = 0.05;
/** Yaw (rad) the bot starts turned toward its direction of travel on a walk. */
const TURN_TRAVEL = 0.6;
/** Walk bob amplitude in metres (engine uses ~0.012; a touch more reads as a walk). */
const BOB_AMPLITUDE = 0.02;
/** Angular speed of the bob phase (rad/s) — matches the engine's `WALK.cadence`. */
const BOB_CADENCE = 6.2;
/** Normalised units traversed per second, used to derive a sensible walk duration. */
const DEFAULT_SPEED = 0.9;
/** Clamp the auto-derived duration so short hops are not instant and long walks not slow. */
const MIN_DURATION_SECONDS = 0.35;
const MAX_DURATION_SECONDS = 2.4;
/** How far past the container edge an entry/exit point sits (fraction of the container). */
const OFFSCREEN_MARGIN = 0.16;
/** Below this the container is "tall/narrow" (a side panel) and corners get clipped. */
const NARROW_ASPECT = 1.1;

// --- Stage catalogue --------------------------------------------------------

const STAGE_TABLE: Record<StageName, Stage> = {
  bottomLeft: {
    name: 'bottomLeft',
    label: 'Bottom left',
    x: 0.2,
    y: 0.26,
    scale: 0.38,
    fitFraction: 0.82,
    anchor: { x: 0.2, y: 0.26 },
  },
  bottomRight: {
    name: 'bottomRight',
    label: 'Bottom right',
    x: 0.8,
    y: 0.26,
    scale: 0.38,
    fitFraction: 0.82,
    anchor: { x: 0.8, y: 0.26 },
  },
  bottomCenter: {
    name: 'bottomCenter',
    label: 'Bottom centre',
    x: 0.5,
    y: 0.22,
    scale: 0.34,
    fitFraction: 0.7,
    anchor: { x: 0.5, y: 0.22 },
  },
  topLeft: {
    name: 'topLeft',
    label: 'Top left',
    x: 0.2,
    y: 0.74,
    scale: 0.3,
    fitFraction: 0.6,
    anchor: { x: 0.2, y: 0.74 },
  },
  topRight: {
    name: 'topRight',
    label: 'Top right',
    x: 0.8,
    y: 0.74,
    scale: 0.3,
    fitFraction: 0.6,
    anchor: { x: 0.8, y: 0.74 },
  },
  center: {
    name: 'center',
    label: 'Centre',
    x: 0.5,
    y: 0.5,
    scale: 0.52,
    fitFraction: 0.88,
    anchor: { x: 0.5, y: 0.5 },
  },
  centerLeft: {
    name: 'centerLeft',
    label: 'Centre left',
    x: 0.26,
    y: 0.5,
    scale: 0.46,
    fitFraction: 0.84,
    anchor: { x: 0.26, y: 0.5 },
  },
  centerRight: {
    name: 'centerRight',
    label: 'Centre right',
    x: 0.74,
    y: 0.5,
    scale: 0.46,
    fitFraction: 0.84,
    anchor: { x: 0.74, y: 0.5 },
  },
  nearCamera: {
    name: 'nearCamera',
    label: 'Near camera',
    x: 0.5,
    y: 0.46,
    scale: 1,
    fitFraction: 1,
    anchor: { x: 0.5, y: 0.46 },
  },
  farLeft: {
    name: 'farLeft',
    label: 'Far left',
    x: 0.12,
    y: 0.3,
    scale: 0.24,
    fitFraction: 0.46,
    anchor: { x: 0.12, y: 0.3 },
  },
  farRight: {
    name: 'farRight',
    label: 'Far right',
    x: 0.88,
    y: 0.3,
    scale: 0.24,
    fitFraction: 0.46,
    anchor: { x: 0.88, y: 0.3 },
  },
};

/**
 * The stage catalogue, keyed by name.
 *
 * A single source of truth: the engine, the menu UI and the path helpers all read
 * from here, so adding a placement is a one-line change rather than four edits.
 */
export const STAGES: Readonly<Record<StageName, Stage>> = STAGE_TABLE;

/**
 * Every stage name, in menu order.
 *
 * Exposed separately from {@link STAGES} because `Object.keys` order is not a
 * contract — this array *is* the order a host should render its picker in, and
 * iterating it is how you guarantee you visit every placement.
 */
export const STAGE_NAMES: readonly StageName[] = [
  'bottomLeft',
  'bottomRight',
  'bottomCenter',
  'centerLeft',
  'center',
  'centerRight',
  'topLeft',
  'topRight',
  'farLeft',
  'farRight',
  'nearCamera',
];

/**
 * Every stage as an array, in the same order as {@link STAGE_NAMES}.
 *
 * Saves the host repeating `STAGE_NAMES.map((n) => STAGES[n])` for its own
 * menus/lists, and keeps that mapping in one place.
 */
export const STAGE_LIST: readonly Stage[] = STAGE_NAMES.map((name) => STAGES[name]);

/**
 * Look up a stage by name, tolerating arbitrary strings from config/URLs.
 *
 * Returns `undefined` instead of throwing so a stale or user-supplied placement
 * degrades to "use the default" rather than crashing the host.
 */
export function getStage(name: string): Stage | undefined {
  const index = STAGES as unknown as Record<string, Stage>;
  return index[name];
}

/**
 * Choose the most sensible default stage for a container aspect ratio (`w / h`).
 *
 * A tall/narrow container (a browser side panel, a mobile portrait strip) clips a
 * corner placement horizontally, so it prefers {@link Stage} `bottomCenter`; a
 * landscape/wide container keeps the familiar bottom-left corner. Non-finite or
 * non-positive ratios fall back to the wide case so callers never get `undefined`.
 */
export function stageForAspect(aspect: number): StageName {
  if (!Number.isFinite(aspect) || aspect <= 0) return 'bottomLeft';
  if (aspect < NARROW_ASPECT) return 'bottomCenter';
  return 'bottomLeft';
}

// --- Paths ------------------------------------------------------------------

/** Tuning for a {@link StagePath}. */
export interface PathOptions {
  /** Which edge the bot enters from / exits toward. Defaults from the stage's side. */
  edge?: Edge;
  /** Total walk time in milliseconds. Defaults from the distance walked. */
  durationMs?: number;
  /** 0..1, how far it travels: scales the start offset while the target stays exact. */
  travel?: number;
  /** vertical hop in metres during the walk */
  hop?: number;
}

/** One frame of a path, ready to hand to the renderer. */
export interface PathSample {
  /** Normalised container x (0 = left, 1 = right). */
  x: number;
  /** Normalised container y (0 = bottom, 1 = top). */
  y: number;
  /** Depth — reserved (always 0 today; the stage plane is flat). */
  z: number;
  /** Yaw in radians; eases from the travel direction toward 0 (facing the viewer). */
  turn: number;
  /** Small vertical oscillation in metres; exactly 0 once finished. */
  bob: number;
  /** 0..1 eased progress along the path. */
  progress: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** The engine's easing (smoothstep); reused so paths match the walk feel. */
function easeInOut(t: number): number {
  return t * t * (3 - 2 * t);
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * A resumable path (entry or exit) the engine can sample every frame.
 *
 * Why a class rather than a function: the engine already owns a per-frame loop
 * (`_updateWalk`), so it needs to advance a path by a delta and read the result —
 * not rebuild a curve each frame. Storing the elapsed time (rather than stepping a
 * normalised value) makes the motion **frame-rate independent**: 30 × 1/30s and
 * 60 × 1/60s produce the same trajectory. Each delta is clamped to 50ms so a
 * backgrounded tab resumes smoothly instead of snapping to the end, and the path
 * is fully deterministic (no randomness), so it is trivial to test.
 */
export class StagePath {
  private readonly _from: { x: number; y: number };
  private readonly _to: { x: number; y: number };
  private readonly _duration: number;
  private readonly _turnStart: number;
  private readonly _turnEnd = 0;
  private readonly _hop: number;
  private _elapsed = 0;
  private _phase = 0;
  private _done = false;

  constructor(from: { x: number; y: number }, to: { x: number; y: number }, options: PathOptions = {}) {
    const toX = finite(to.x, 0);
    const toY = finite(to.y, 0);

    // `travel` scales the *start* offset, never the target, so the path always
    // ends exactly on `to` regardless of how far it was asked to travel.
    const travel = clamp(finite(options.travel ?? 1, 1), 0, 1);
    const originalFromX = finite(from.x, toX);
    const originalFromY = finite(from.y, toY);
    const fromX = toX + (originalFromX - toX) * travel;
    const fromY = toY + (originalFromY - toY) * travel;

    this._from = { x: fromX, y: fromY };
    this._to = { x: toX, y: toY };

    const dx = toX - fromX;
    const dy = toY - fromY;
    const distance = Math.hypot(dx, dy);

    const durationMs = options.durationMs;
    this._duration =
      Number.isFinite(durationMs) && (durationMs as number) > 0
        ? Math.max(0.001, (durationMs as number) / 1000)
        : clamp(distance / DEFAULT_SPEED, MIN_DURATION_SECONDS, MAX_DURATION_SECONDS);

    // A side entry walks in half-profile, then turns to face the viewer; the sign
    // matches the engine's walk yaw (positive = travelling right).
    const travelSign = Math.abs(dx) >= 1e-6 ? (dx > 0 ? 1 : -1) : 0;
    this._turnStart = travelSign * TURN_TRAVEL;

    this._hop = Math.max(0, finite(options.hop ?? 0, 0));
  }

  /**
   * Advance by `deltaSeconds`; returns the sample for this frame and `done` once
   * finished. After `done` it keeps returning the exact final sample, so the
   * engine can keep calling it without a guard.
   */
  update(deltaSeconds: number): PathSample & { done: boolean } {
    if (this._done) return this._sample();

    const dt = clamp(finite(deltaSeconds, 0), 0, MAX_STEP_SECONDS);
    this._elapsed = Math.min(this._elapsed + dt, this._duration);
    this._phase += dt * BOB_CADENCE;
    if (this._elapsed >= this._duration) {
      this._elapsed = this._duration;
      this._done = true;
    }
    return this._sample();
  }

  /** Start again from the beginning (idempotent; clears the finished flag). */
  reset(): void {
    this._elapsed = 0;
    this._phase = 0;
    this._done = false;
  }

  /** 0..1 progress along the path (1 once finished). */
  get progress(): number {
    return this._duration > 0 ? clamp(this._elapsed / this._duration, 0, 1) : 1;
  }

  /** Whether the path has reached its target. */
  get finished(): boolean {
    return this._done;
  }

  private _sample(): PathSample & { done: boolean } {
    // When finished, short-circuit to the exact target: guarantees `progress === 1`,
    // integer `x`/`y` equal to the target, and `bob === 0` with no float drift.
    if (this._done) {
      return { x: this._to.x, y: this._to.y, z: 0, turn: this._turnEnd, bob: 0, progress: 1, done: true };
    }

    const progress = this.progress;
    const eased = easeInOut(progress);

    // Bob is a two-beat oscillation windowed by `sin(pi * progress)`, so it fades
    // in and out and is *exactly* 0 at both ends (a clean stop, no pop).
    const window = Math.sin(Math.PI * progress);
    const oscillation = 0.5 - 0.5 * Math.cos(2 * this._phase);
    const bob = (BOB_AMPLITUDE * oscillation + this._hop) * window;

    return {
      x: lerp(this._from.x, this._to.x, eased),
      y: lerp(this._from.y, this._to.y, eased),
      z: 0,
      turn: lerp(this._turnStart, this._turnEnd, eased),
      bob,
      progress,
      done: false,
    };
  }
}

/** The edge a stage most naturally enters from / exits toward. */
function defaultEdge(stage: Stage): Edge {
  if (stage.x < 0.45) return 'left';
  if (stage.x > 0.55) return 'right';
  return 'bottom';
}

/** A point just past the container edge, aligned with `stage` on the other axis. */
function offscreenPoint(stage: Stage, edge: Edge): { x: number; y: number } {
  switch (edge) {
    case 'left':
      return { x: -OFFSCREEN_MARGIN, y: stage.y };
    case 'right':
      return { x: 1 + OFFSCREEN_MARGIN, y: stage.y };
    case 'top':
      return { x: stage.x, y: 1 + OFFSCREEN_MARGIN };
    case 'bottom':
    default:
      return { x: stage.x, y: -OFFSCREEN_MARGIN };
  }
}

/**
 * An entry path from off-screen to `stage`.
 *
 * The edge defaults from the stage's horizontal position (left stages enter from
 * the left) so the common case is one argument, while `options.edge` lets a host
 * force a dramatic top-drop or a rise from the bottom.
 */
export function entryPath(stage: StageName, options: PathOptions = {}): StagePath {
  const target = STAGES[stage];
  const edge = options.edge ?? defaultEdge(target);
  return new StagePath(offscreenPoint(target, edge), { x: target.x, y: target.y }, { ...options, edge });
}

/**
 * An exit path from `stage` off-screen.
 *
 * Mirrors {@link entryPath}: same edge heuristic, same easing and turn behaviour,
 * so a bot that entered and later leaves retraces a familiar route.
 */
export function exitPath(stage: StageName, options: PathOptions = {}): StagePath {
  const target = STAGES[stage];
  const edge = options.edge ?? defaultEdge(target);
  return new StagePath({ x: target.x, y: target.y }, offscreenPoint(target, edge), { ...options, edge });
}
