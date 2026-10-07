/**
 * Pure camera-framing math for the VRM avatar.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `AvatarEngine` originally did its camera fit inline, in a private
 * `_computeFraming()` method, and that method ran only at load time — against
 * the model's *rest* pose. Two problems followed from that:
 *
 *  1. The fit was frozen. As soon as a clip moved the skeleton, anything that
 *     escaped the rest-pose silhouette — arms raised overhead, a jump, a wide
 *     gesture — was quietly cropped by the viewport.
 *  2. The fit understood height only. A wide silhouette ("arms out" / T-pose)
 *     was fitted purely by its vertical extent, so despite the horizontal
 *     room the aspect ratio provides, the subject stayed too close and got
 *     clipped left and right.
 *
 * Extracting the maths into this dependency-free module — no `three`, no DOM —
 * lets the engine re-fit every frame against the avatar's *current*
 * world-space bounds, and lets us unit-test the geometry directly.
 *
 * The vertical fit is intentionally bit-for-bit identical to the engine's old
 * inline formula for a tall, narrow subject, so switching the engine over to
 * this module does not visibly move the camera for any existing composition.
 */

/**
 * An axis-aligned box in world metres.
 *
 * WHY: the engine already produces one via `new THREE.Box3().setFromObject(...)`.
 * This plain interface keeps the maths decoupled from three.js — the engine or
 * a key-bone sampler can build it from any source (a `Box3`, joint positions,
 * animated-bone samples) without dragging three.js into our tests.
 */
export interface Bounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/**
 * Everything `solveFrame` needs to place the camera for one frame.
 *
 * WHY: framed as an explicit request object so the caller (engine or test) can
 * pass the avatar's *current* bounds plus the fixed camera configuration, and
 * get a deterministic answer back — the function is pure and has no hidden
 * state, which is what makes per-frame re-fitting safe and cheap.
 */
export interface FrameRequest {
  /** World-space bounds that must fit on screen. */
  bounds: Bounds;
  /** Fraction of the viewport height the bounds should occupy (0..1). */
  fitFraction: number;
  /** Camera aspect ratio (w/h). */
  aspect: number;
  /** Vertical field of view in degrees. */
  fovDeg: number;
  /** 0 = bottom, 1 = top — where the subject sits vertically. */
  anchorY: number;
  /** 0 = left, 1 = right — used to compute `homeX`. */
  anchorX: number;
  /** Never place the camera closer than this (metres). Default 0. */
  minDistance?: number;
}

/**
 * The camera placement that fits a {@link FrameRequest}.
 *
 * WHY: mirrors exactly the values the engine needs to commit each frame
 * (`camera.position.set(0, lookAtY, distance)`, the on-screen extents used by
 * staging/walk logic, and `homeX` for the resting X of the model), so the
 * caller can apply a solution with no further maths.
 */
export interface FrameSolution {
  /** Camera Z (metres, looking down -Z at the subject). */
  distance: number;
  /** Height the camera looks at. */
  lookAtY: number;
  visibleHeight: number;
  visibleWidth: number;
  /** Model X for the current anchor. */
  homeX: number;
  /** Bounds centre X (for horizontal re-centring). */
  centerX: number;
}

// --- Tunables / guards -----------------------------------------------------

/** `THREE.MathUtils.DEG2RAD`: keeps our trig numerically identical to three.js. */
const DEG2RAD = Math.PI / 180;

/** Viewport-occupation clamps (mirrors the engine's own `fitFraction` clamp). */
const MIN_FIT_FRACTION = 0.05;
const MAX_FIT_FRACTION = 1;
/** Field-of-view clamps: a non-positive/huge FOV is nonsense and yields NaN distances. */
const MIN_FOV_DEG = 1;
const MAX_FOV_DEG = 170;
/** Aspect clamps: guards against a 0/NaN aspect collapsing the horizontal frustum. */
const MIN_ASPECT = 0.1;
const MAX_ASPECT = 10;
/** A subject is never treated as shorter than this, so the camera never jams into it. */
const MIN_HEIGHT = 0.2;
/** Floor used only when we had to fall back from nonsense input. */
const FALLBACK_MIN_DISTANCE = 0.5;

/** Defaults used when a field is missing or non-finite (match the engine). */
const DEFAULT_FIT_FRACTION = 0.82;
const DEFAULT_FOV_DEG = 30;
const DEFAULT_ASPECT = 1;
const DEFAULT_ANCHOR = 0.5;

/**
 * The box used when the caller hands us nonsense bounds: a plausible 1.7 m
 * adult standing at the origin, so the camera still lands somewhere sane
 * instead of throwing or producing NaN.
 */
const FALLBACK_BOUNDS: Bounds = {
  minX: -0.85,
  minY: 0,
  minZ: -0.85,
  maxX: 0.85,
  maxY: 1.7,
  maxZ: 0.85,
};

// --- Internal helpers ------------------------------------------------------

/** `deg * (PI / 180)` — the same double three.js produces, so parity holds. */
function degToRad(deg: number): number {
  return deg * DEG2RAD;
}

/** Coerce anything to a finite number, or return `fallback`. */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Clamp `value` into `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

// --- Public API ------------------------------------------------------------

/**
 * Fit `bounds` in view. Pure; never returns NaN/Infinity.
 *
 * WHY: the engine calls this once per frame with the avatar's live world
 * bounds, so poses that reach past the rest silhouette (arms up, jumps, wide
 * gestures) are re-framed instead of cropped. The distance is the larger of
 * the vertical and horizontal requirements — see below — which is the whole
 * point: the old height-only fit ignored width entirely.
 *
 * The vertical term reproduces the engine's original formula exactly:
 * `visibleHeight = height / fitFraction`,
 * `distance = visibleHeight / 2 / tan(degToRad(fov) / 2)`.
 *
 * The horizontal term mirrors it on the other axis. Because the frustum is
 * wider by `aspect`, `tan(fovH/2) = tan(fovV/2) * aspect`, so a subject of
 * width `w` needs `distance >= (w / fitFraction) / 2 / tan(fovH/2)`.
 *
 * Every input is clamped/guarded; on nonsense input we fall back to a 1.7 m
 * stand-in box, and the result is always finite with `distance >= 0.5`.
 */
export function solveFrame(request: FrameRequest): FrameSolution {
  // Read defensively — a JS caller (or an untyped config path) may omit fields.
  const raw: Partial<FrameRequest> | null | undefined = request;

  const fitFraction = clamp(
    finiteOr(raw?.fitFraction, DEFAULT_FIT_FRACTION),
    MIN_FIT_FRACTION,
    MAX_FIT_FRACTION,
  );
  const fovDeg = clamp(finiteOr(raw?.fovDeg, DEFAULT_FOV_DEG), MIN_FOV_DEG, MAX_FOV_DEG);
  const aspect = clamp(finiteOr(raw?.aspect, DEFAULT_ASPECT), MIN_ASPECT, MAX_ASPECT);

  // Anchors are documented as 0..1; we only reject non-numbers (a caller asking
  // for an off-centre subject is honoured rather than silently clamped).
  const anchorY = finiteOr(raw?.anchorY, DEFAULT_ANCHOR);
  const anchorX = finiteOr(raw?.anchorX, DEFAULT_ANCHOR);
  const minDistance = Math.max(0, finiteOr(raw?.minDistance, 0));

  const candidate = raw?.bounds;
  const bounds: Bounds = candidate && isFiniteBounds(candidate) ? candidate : FALLBACK_BOUNDS;
  const usedFallback = bounds === FALLBACK_BOUNDS;

  const height = Math.max(MIN_HEIGHT, bounds.maxY - bounds.minY);
  const width = Math.max(0, bounds.maxX - bounds.minX);
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const centerX = (bounds.minX + bounds.maxX) / 2;

  const tanHalfVertical = Math.tan(degToRad(fovDeg) / 2);
  const tanHalfHorizontal = tanHalfVertical * aspect;

  // Vertical fit — verbatim engine maths, so a tall narrow subject is unchanged.
  const verticalVisibleHeight = height / fitFraction;
  const distanceVertical = verticalVisibleHeight / 2 / tanHalfVertical;

  // Horizontal fit — the same maths on the width axis, widened by the aspect.
  const distanceHorizontal = width > 0 ? width / fitFraction / 2 / tanHalfHorizontal : 0;

  let distance = Math.max(
    distanceVertical,
    distanceHorizontal,
    minDistance,
    usedFallback ? FALLBACK_MIN_DISTANCE : 0,
  );
  // Belt-and-braces: no path above should be able to produce a non-finite value,
  // but we refuse to hand the renderer one if it somehow did.
  if (!Number.isFinite(distance) || distance <= 0) distance = FALLBACK_MIN_DISTANCE;

  // When the vertical constraint is what set the distance, keep the
  // vertical-derived visible height bit-for-bit (parity with the old engine).
  // Otherwise the horizontal fit widened the frame, so grow the height to match
  // the final distance and keep `visibleWidth === visibleHeight * aspect` true.
  const visibleHeight =
    distance === distanceVertical ? verticalVisibleHeight : 2 * distance * tanHalfVertical;
  const visibleWidth = visibleHeight * aspect;

  const lookAtY = centerY + (anchorY - 0.5) * visibleHeight;
  const homeX = (anchorX - 0.5) * visibleWidth;

  return { distance, lookAtY, visibleHeight, visibleWidth, homeX, centerX };
}

/**
 * Smallest bounds containing both.
 *
 * WHY: the engine samples several key bones (head, hands, feet) to approximate
 * the live silhouette cheaply; folding those per-bone boxes together with this
 * function builds one box that is guaranteed to contain all of them, and being
 * a plain component-wise min/max it is order-independent (commutative).
 */
export function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    minZ: Math.min(a.minZ, b.minZ),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
    maxZ: Math.max(a.maxZ, b.maxZ),
  };
}

/**
 * A bounds from a centre point and a radius (used for key-bone sampling).
 *
 * WHY: a single bone is a point; sampling it needs a little padding to be
 * meaningful. This makes a cube of side `2 * radius` centred on the bone.
 * `radius` is treated as a magnitude (its sign is ignored) and every field is
 * coerced to a finite number, so the result always satisfies `min <= max` and
 * can never poison a subsequent {@link unionBounds}.
 */
export function boundsAround(x: number, y: number, z: number, radius: number): Bounds {
  const cx = finiteOr(x, 0);
  const cy = finiteOr(y, 0);
  const cz = finiteOr(z, 0);
  const r = Math.abs(finiteOr(radius, 0));
  return {
    minX: cx - r,
    minY: cy - r,
    minZ: cz - r,
    maxX: cx + r,
    maxY: cy + r,
    maxZ: cz + r,
  };
}

/**
 * True when every field is finite and min <= max.
 *
 * WHY: this is the single gate that decides whether live, pose-derived bounds
 * are trustworthy enough to fit against. An animated rig can momentarily
 * produce NaN (a zero-length quaternion slerp, a missing bone) and a malformed
 * box would blast the camera to infinity; the engine checks this and falls
 * back to a safe box instead.
 */
export function isFiniteBounds(bounds: Bounds): boolean {
  const b: Bounds | null | undefined = bounds;
  if (!b) return false;
  return (
    Number.isFinite(b.minX) &&
    Number.isFinite(b.minY) &&
    Number.isFinite(b.minZ) &&
    Number.isFinite(b.maxX) &&
    Number.isFinite(b.maxY) &&
    Number.isFinite(b.maxZ) &&
    b.minX <= b.maxX &&
    b.minY <= b.maxY &&
    b.minZ <= b.maxZ
  );
}
