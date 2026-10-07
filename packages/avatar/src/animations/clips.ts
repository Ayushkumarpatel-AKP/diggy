import type { VRMHumanBoneName } from '@pixiv/three-vrm';
import type { BoneOffset } from '../idle.js';

/**
 * The animation clip library.
 *
 * Conventions used by every clip in this file:
 *
 * - `pose()` returns **additive** Euler offsets (radians) keyed by VRM humanoid
 *   bone name. They are layered on top of the avatar's base "arms at rest" pose
 *   (`BASE_POSE` in `../idle.ts`), exactly like the `extra` offsets accepted by
 *   `ProceduralIdle.update`. Offsets are never absolute.
 * - Mirroring a pose flips the sign of the **y and z** components (and leaves x
 *   alone), so `leftUpperArm.z = +a` pairs with `rightUpperArm.z = -a`.
 * - Looping clips (`loop: true`) are loop-safe: every driver is a function of
 *   `progress` with an integer number of cycles per loop (`wave`, `bend`,
 *   `crest`, `waveCos`), so the pose at `progress` 0 and 1 is identical.
 * - Non-looping clips use `ramp`/`hold` envelopes so they start and end at the
 *   rest pose.
 * - Only the 20 bones below are ever driven (see `REST_BONES` in `../idle.ts`).
 * - Amplitudes: big dance motion stays within ±0.9 rad, calm/idle motion within
 *   ±0.35 rad. Nothing in here can produce NaN, even for a hostile context.
 */

/** Which family a clip belongs to — useful for menus, random picks and filters. */
export type ClipCategory =
  | 'entry'
  | 'exit'
  | 'dance'
  | 'gesture'
  | 'emote'
  | 'pose'
  | 'idle'
  | 'action';

/** Per-frame sampling context handed to a clip. */
export interface ClipContext {
  /** Seconds elapsed since the clip started. */
  time: number;
  /** Normalised playhead: 0 on the first frame, 1 at the end of the clip. */
  progress: number;
}

/**
 * Whole-avatar motion for a clip. `x`/`y`/`z` are metres (world space), `turn`
 * is yaw in radians and `bob` is an extra vertical bounce layered on top of
 * `y`. All fields default to 0 when omitted.
 */
export interface RootMotion {
  x?: number;
  y?: number;
  z?: number;
  turn?: number;
  bob?: number;
}

/** A single, procedurally generated animation. */
export interface AnimationClip {
  id: string;
  label: string;
  category: ClipCategory;
  durationMs: number;
  loop: boolean;
  pose(ctx: ClipContext): Partial<Record<VRMHumanBoneName, BoneOffset>>;
  root?(ctx: ClipContext): RootMotion;
}

const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ *
 * Numeric helpers — all of them are total (never NaN, never throw).
 * ------------------------------------------------------------------ */

function finite(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function clamp01(v: number): number {
  const n = finite(v);
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

/** Hermite smoothstep on an already normalised, clamped input. */
function smooth(t: number): number {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

/**
 * Loop-safe sine of the playhead: `cycles` full oscillations across the loop.
 * `wave(0) === wave(1)` for any integer `cycles`.
 */
function wave(progress: number, cycles = 1, phase = 0): number {
  return Math.sin(TAU * (cycles * finite(progress) + phase));
}

/** Loop-safe cosine of the playhead. */
function waveCos(progress: number, cycles = 1, phase = 0): number {
  return Math.cos(TAU * (cycles * finite(progress) + phase));
}

/** Loop-safe "0 at the loop seam, 1 mid-cycle" curve (knee/elbow style). */
function bend(progress: number, cycles = 1, phase = 0): number {
  return 0.5 - 0.5 * waveCos(progress, cycles, phase);
}

/** Loop-safe "1 at the loop seam, 0 mid-cycle" curve (bounce/hop style). */
function crest(progress: number, cycles = 1, phase = 0): number {
  return 0.5 + 0.5 * waveCos(progress, cycles, phase);
}

/** Smooth 0→1 ramp between `a` and `b` (progress space). */
function ramp(progress: number, a: number, b: number): number {
  if (b <= a) return finite(progress) >= b ? 1 : 0;
  return smooth((clamp01(progress) - a) / (b - a));
}

/**
 * A one-shot envelope: 0 outside `[a, d]`, ramping smoothly up over `[a, b]`,
 * holding 1 over `[b, c]` and back down over `[c, d]`. Always 0 at progress 0
 * (when `a >= 0`) and at progress 1 (when `d <= 1`), which keeps non-looping
 * clips anchored to the rest pose.
 */
function hold(progress: number, a: number, b: number, c: number, d: number): number {
  const p = clamp01(progress);
  if (p <= a || p >= d) return 0;
  if (p < b) return smooth((p - a) / Math.max(1e-6, b - a));
  if (p > c) return 1 - smooth((p - c) / Math.max(1e-6, d - c));
  return 1;
}

/**
 * Smooth 0 → 1 → 0 bump with the given `period` (seconds). `time` is seconds.
 * Useful for one-shot "accent" motion such as a nod, a step or a hop.
 */
export function pulse(time: number, period: number): number {
  const p = finite(period);
  if (p <= 0) return 0;
  const t = finite(time);
  const phase = ((t % p) + p) % p / p;
  return Math.sin(Math.PI * phase);
}

/**
 * Sine wave of `time` (seconds) with the given `period` (seconds) and
 * `amplitude`. Unlike `wave`, this is driven by absolute time rather than the
 * playhead — use it for idle-ish motion or non-looping accents.
 */
export function sway(time: number, period: number, amplitude = 1): number {
  const p = finite(period);
  if (p <= 0) return 0;
  return finite(amplitude) * Math.sin((finite(time) / p) * TAU);
}

/* ------------------------------------------------------------------ *
 * The clip library.
 * ------------------------------------------------------------------ */

const CLIPS = [
  /* ----------------------------- entry ----------------------------- */
  {
    id: 'enter.walkIn',
    label: 'Walk in',
    category: 'entry',
    durationMs: 1600,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const env = ramp(p, 0, 0.12) * (1 - ramp(p, 0.86, 1));
      const s = env * wave(p, 6);
      const b = env * bend(p, 6, 0.25);
      const c = env * crest(p, 6, 0.25);
      return {
        hips: { x: 0.05 * env, y: 0.07 * s, z: 0.03 * env * wave(p, 3) },
        spine: { x: 0.05 * env, y: -0.05 * s },
        chest: { x: 0.04 * env, y: -0.06 * s },
        upperChest: { y: -0.03 * s },
        neck: { x: -0.03 * env, y: 0.03 * s },
        head: { y: 0.05 * s, z: 0.02 * env * wave(p, 3) },
        leftShoulder: { z: -0.05 * s },
        rightShoulder: { z: -0.05 * s },
        leftUpperArm: { z: -0.16 * env, y: -0.28 * s },
        rightUpperArm: { z: 0.16 * env, y: -0.28 * s },
        leftLowerArm: { y: -0.3 * env, z: 0.12 * env },
        rightLowerArm: { y: 0.3 * env, z: -0.12 * env },
        leftHand: { z: 0.1 * env },
        rightHand: { z: -0.1 * env },
        leftUpperLeg: { x: -0.45 * s, z: -0.03 * env },
        rightUpperLeg: { x: 0.45 * s, z: 0.03 * env },
        leftLowerLeg: { x: 0.5 * b },
        rightLowerLeg: { x: 0.5 * c },
        leftFoot: { x: 0.18 * b },
        rightFoot: { x: 0.18 * c },
      };
    },
    root(ctx: ClipContext) {
      const p = ctx.progress;
      return {
        x: -1.6 * (1 - ramp(p, 0, 0.9)),
        bob: 0.035 * wave(p, 6, 0.25),
      };
    },
  },
  {
    id: 'enter.runIn',
    label: 'Run in',
    category: 'entry',
    durationMs: 1500,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const env = ramp(p, 0, 0.1) * (1 - ramp(p, 0.88, 1));
      const s = env * wave(p, 8);
      const b = env * bend(p, 8, 0.25);
      const c = env * crest(p, 8, 0.25);
      return {
        hips: { x: 0.12 * env, y: 0.1 * s },
        spine: { x: 0.14 * env, y: -0.08 * s },
        chest: { x: 0.12 * env, y: -0.1 * s },
        upperChest: { x: 0.05 * env },
        neck: { x: -0.12 * env },
        head: { x: -0.08 * env, y: 0.04 * s },
        leftShoulder: { z: -0.08 * s },
        rightShoulder: { z: -0.08 * s },
        leftUpperArm: { z: -0.3 * env, y: -0.55 * s },
        rightUpperArm: { z: 0.3 * env, y: -0.55 * s },
        leftLowerArm: { y: -0.85 * env, z: 0.2 * env },
        rightLowerArm: { y: 0.85 * env, z: -0.2 * env },
        leftHand: { z: 0.18 * env },
        rightHand: { z: -0.18 * env },
        leftUpperLeg: { x: -0.7 * s },
        rightUpperLeg: { x: 0.7 * s },
        leftLowerLeg: { x: 0.8 * b },
        rightLowerLeg: { x: 0.8 * c },
        leftFoot: { x: 0.28 * b },
        rightFoot: { x: 0.28 * c },
      };
    },
    root(ctx: ClipContext) {
      const p = ctx.progress;
      return {
        x: -2.8 * (1 - ramp(p, 0, 0.9)),
        bob: 0.06 * wave(p, 8, 0.25),
      };
    },
  },
  {
    id: 'enter.jumpIn',
    label: 'Jump in',
    category: 'entry',
    durationMs: 1300,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const crouch = hold(p, 0, 0.09, 0.12, 0.24);
      const air = hold(p, 0.1, 0.28, 0.44, 0.62);
      const land = hold(p, 0.6, 0.72, 0.78, 0.96);
      const down = crouch + land;
      return {
        hips: { x: 0.16 * down },
        spine: { x: 0.12 * down - 0.06 * air },
        chest: { x: 0.1 * down - 0.08 * air },
        neck: { x: 0.04 * down - 0.1 * air },
        head: { x: 0.05 * down - 0.12 * air },
        leftShoulder: { z: 0.06 * air },
        rightShoulder: { z: -0.06 * air },
        leftUpperArm: { z: -0.25 * crouch + 0.9 * air, y: 0.3 * crouch - 0.1 * air },
        rightUpperArm: { z: 0.25 * crouch - 0.9 * air, y: -0.3 * crouch + 0.1 * air },
        leftLowerArm: { y: 0.3 * crouch - 0.35 * air, z: 0.15 * down },
        rightLowerArm: { y: -0.3 * crouch + 0.35 * air, z: -0.15 * down },
        leftUpperLeg: { x: -0.5 * crouch - 0.35 * land - 0.25 * air, z: -0.05 * down },
        rightUpperLeg: { x: -0.5 * crouch - 0.35 * land - 0.25 * air, z: 0.05 * down },
        leftLowerLeg: { x: 0.8 * crouch + 0.65 * land + 0.2 * air },
        rightLowerLeg: { x: 0.8 * crouch + 0.65 * land + 0.2 * air },
        leftFoot: { x: 0.3 * down },
        rightFoot: { x: 0.3 * down },
      };
    },
    root(ctx: ClipContext) {
      const p = ctx.progress;
      const air = hold(p, 0.1, 0.28, 0.44, 0.62);
      return {
        x: -1.8 * (1 - ramp(p, 0, 0.85)),
        y: 0.6 * air,
        bob: 0.04,
      };
    },
  },
  {
    id: 'enter.spinIn',
    label: 'Spin in',
    category: 'entry',
    durationMs: 1500,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const env = hold(p, 0.08, 0.24, 0.68, 0.94);
      const s = env * wave(p, 2);
      return {
        hips: { y: 0.25 * s, z: 0.05 * s },
        spine: { y: -0.12 * s, x: 0.05 * env },
        chest: { y: -0.1 * s, z: 0.06 * env },
        upperChest: { y: -0.06 * s },
        neck: { y: -0.1 * s },
        head: { y: -0.16 * s, x: -0.06 * env },
        leftShoulder: { z: 0.08 * env },
        rightShoulder: { z: -0.08 * env },
        leftUpperArm: { z: 0.75 * env, y: -0.2 * env - 0.15 * s },
        rightUpperArm: { z: -0.75 * env, y: 0.2 * env + 0.15 * s },
        leftLowerArm: { z: 0.3 * env, y: -0.15 * env },
        rightLowerArm: { z: -0.3 * env, y: 0.15 * env },
        leftUpperLeg: { x: -0.18 * env, z: -0.08 * s },
        rightUpperLeg: { x: 0.18 * env, z: 0.08 * s },
        leftLowerLeg: { x: 0.3 * env },
        rightLowerLeg: { x: 0.2 * env },
      };
    },
    root(ctx: ClipContext) {
      const p = ctx.progress;
      const env = hold(p, 0.08, 0.24, 0.68, 0.94);
      return {
        x: -1.3 * (1 - ramp(p, 0, 0.55)),
        turn: TAU * ramp(p, 0.06, 0.86),
        bob: 0.04 * env,
      };
    },
  },

  /* ------------------------------ exit ----------------------------- */
  {
    id: 'exit.walkOut',
    label: 'Walk out',
    category: 'exit',
    durationMs: 1700,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const env = 1 - ramp(p, 0.5, 0.98);
      const s = env * wave(p, 6);
      const b = env * bend(p, 6, 0.25);
      const c = env * crest(p, 6, 0.25);
      return {
        hips: { x: 0.05 * env, y: 0.07 * s, z: 0.03 * env * wave(p, 3) },
        spine: { x: 0.05 * env, y: -0.05 * s },
        chest: { x: 0.04 * env, y: -0.06 * s },
        neck: { x: -0.03 * env },
        head: { y: 0.05 * s },
        leftShoulder: { z: -0.05 * s },
        rightShoulder: { z: -0.05 * s },
        leftUpperArm: { z: -0.16 * env, y: -0.28 * s },
        rightUpperArm: { z: 0.16 * env, y: -0.28 * s },
        leftLowerArm: { y: -0.3 * env, z: 0.12 * env },
        rightLowerArm: { y: 0.3 * env, z: -0.12 * env },
        leftUpperLeg: { x: -0.45 * s },
        rightUpperLeg: { x: 0.45 * s },
        leftLowerLeg: { x: 0.5 * b },
        rightLowerLeg: { x: 0.5 * c },
        leftFoot: { x: 0.18 * b },
        rightFoot: { x: 0.18 * c },
      };
    },
    root(ctx: ClipContext) {
      const p = ctx.progress;
      const env = 1 - ramp(p, 0.5, 0.98);
      return {
        x: 1.9 * ramp(p, 0.04, 0.96),
        bob: 0.035 * env * wave(p, 6, 0.25),
      };
    },
  },
  {
    id: 'exit.runOut',
    label: 'Run out',
    category: 'exit',
    durationMs: 1500,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const env = 1 - ramp(p, 0.55, 1);
      const s = env * wave(p, 8);
      const b = env * bend(p, 8, 0.25);
      const c = env * crest(p, 8, 0.25);
      return {
        hips: { x: 0.12 * env, y: 0.1 * s },
        spine: { x: 0.14 * env, y: -0.08 * s },
        chest: { x: 0.12 * env, y: -0.1 * s },
        neck: { x: -0.12 * env },
        head: { x: -0.08 * env },
        leftShoulder: { z: -0.08 * s },
        rightShoulder: { z: -0.08 * s },
        leftUpperArm: { z: -0.3 * env, y: -0.55 * s },
        rightUpperArm: { z: 0.3 * env, y: -0.55 * s },
        leftLowerArm: { y: -0.85 * env, z: 0.2 * env },
        rightLowerArm: { y: 0.85 * env, z: -0.2 * env },
        leftUpperLeg: { x: -0.7 * s },
        rightUpperLeg: { x: 0.7 * s },
        leftLowerLeg: { x: 0.8 * b },
        rightLowerLeg: { x: 0.8 * c },
        leftFoot: { x: 0.28 * b },
        rightFoot: { x: 0.28 * c },
      };
    },
    root(ctx: ClipContext) {
      const p = ctx.progress;
      const env = 1 - ramp(p, 0.55, 1);
      return {
        x: 3.2 * ramp(p, 0.02, 0.94),
        bob: 0.06 * env * wave(p, 8, 0.25),
      };
    },
  },
  {
    id: 'exit.jumpOut',
    label: 'Jump out',
    category: 'exit',
    durationMs: 1300,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const crouch = hold(p, 0, 0.1, 0.14, 0.26);
      const air = hold(p, 0.14, 0.32, 0.48, 0.68);
      const land = hold(p, 0.66, 0.76, 0.82, 0.98);
      const down = crouch + land;
      return {
        hips: { x: 0.16 * down - 0.06 * air },
        spine: { x: 0.12 * down - 0.05 * air },
        chest: { x: 0.1 * down - 0.06 * air },
        neck: { x: -0.08 * air },
        head: { x: 0.05 * down - 0.1 * air },
        leftUpperArm: { z: -0.25 * crouch + 0.85 * air, y: 0.3 * crouch - 0.15 * air },
        rightUpperArm: { z: 0.25 * crouch - 0.85 * air, y: -0.3 * crouch + 0.15 * air },
        leftLowerArm: { y: 0.3 * crouch - 0.3 * air, z: 0.15 * down },
        rightLowerArm: { y: -0.3 * crouch + 0.3 * air, z: -0.15 * down },
        leftUpperLeg: { x: -0.5 * crouch - 0.35 * land - 0.3 * air },
        rightUpperLeg: { x: -0.5 * crouch - 0.35 * land - 0.3 * air },
        leftLowerLeg: { x: 0.8 * crouch + 0.65 * land + 0.25 * air },
        rightLowerLeg: { x: 0.8 * crouch + 0.65 * land + 0.25 * air },
        leftFoot: { x: 0.3 * down },
        rightFoot: { x: 0.3 * down },
      };
    },
    root(ctx: ClipContext) {
      const p = ctx.progress;
      const air = hold(p, 0.14, 0.32, 0.48, 0.68);
      return {
        x: 1.7 * ramp(p, 0.08, 0.9),
        y: 0.55 * air,
        bob: 0.04,
      };
    },
  },
  {
    id: 'exit.bowOut',
    label: 'Bow out',
    category: 'exit',
    durationMs: 1800,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const e = hold(p, 0.04, 0.3, 0.58, 0.96);
      return {
        hips: { x: 0.18 * e },
        spine: { x: 0.3 * e },
        chest: { x: 0.26 * e },
        upperChest: { x: 0.12 * e },
        neck: { x: 0.2 * e },
        head: { x: 0.16 * e },
        leftShoulder: { z: -0.08 * e },
        rightShoulder: { z: 0.08 * e },
        leftUpperArm: { y: -0.4 * e, z: -0.15 * e },
        rightUpperArm: { y: 0.4 * e, z: 0.15 * e },
        leftLowerArm: { y: -0.35 * e, z: 0.15 * e },
        rightLowerArm: { y: 0.35 * e, z: -0.15 * e },
        leftHand: { z: 0.15 * e },
        rightHand: { z: -0.15 * e },
        leftUpperLeg: { x: -0.06 * e },
        rightUpperLeg: { x: -0.06 * e },
        leftLowerLeg: { x: 0.12 * e },
        rightLowerLeg: { x: 0.12 * e },
      };
    },
    root(ctx: ClipContext) {
      const p = ctx.progress;
      const e = hold(p, 0.04, 0.3, 0.58, 0.96);
      return { bob: -0.05 * e, z: -0.04 * e };
    },
  },

  /* ----------------------------- dance ----------------------------- */
  {
    id: 'dance.hipSway',
    label: 'Hip sway',
    category: 'dance',
    durationMs: 2200,
    loop: true,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const s = wave(p, 1);
      const c = waveCos(p, 1);
      return {
        hips: { x: 0.03 * c, y: 0.4 * s, z: 0.14 * s },
        spine: { y: -0.16 * s, z: -0.06 * s },
        chest: { x: 0.04 * c, y: -0.14 * s, z: -0.05 * s },
        upperChest: { y: -0.06 * s },
        neck: { y: 0.08 * s },
        head: { y: 0.14 * s, z: -0.07 * s },
        leftShoulder: { z: -0.05 * s },
        rightShoulder: { z: -0.05 * s },
        leftUpperArm: { z: 0.4 + 0.3 * s, y: -0.1 - 0.1 * s },
        rightUpperArm: { z: -0.4 + 0.3 * s, y: 0.1 - 0.1 * s },
        leftLowerArm: { y: -0.5 - 0.15 * s, z: 0.3 },
        rightLowerArm: { y: 0.5 - 0.15 * s, z: -0.3 },
        leftUpperLeg: { x: -0.08 * s, z: -0.06 * s },
        rightUpperLeg: { x: 0.08 * s, z: 0.06 * s },
        leftLowerLeg: { x: 0.15 * (1 - s) * 0.5 },
        rightLowerLeg: { x: 0.15 * (1 + s) * 0.5 },
      };
    },
    root(ctx: ClipContext) {
      const p = ctx.progress;
      return { x: 0.1 * wave(p, 1), bob: 0.03 * crest(p, 2) };
    },
  },
  {
    id: 'dance.robot',
    label: 'Robot',
    category: 'dance',
    durationMs: 1800,
    loop: true,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const q = wave(p, 4);
      const q2 = wave(p, 2);
      return {
        hips: { y: 0.28 * q, z: -0.07 * q2 },
        spine: { x: 0.04, y: -0.14 * q },
        chest: { x: 0.04, y: -0.16 * q },
        neck: { y: 0.12 * q },
        head: { y: -0.3 * q, z: 0.1 * q2, x: -0.04 },
        leftShoulder: { z: 0.1 * q },
        rightShoulder: { z: 0.1 * q },
        leftUpperArm: { z: 0.6 + 0.35 * q, y: -0.3 },
        rightUpperArm: { z: -0.6 - 0.35 * q, y: 0.3 },
        leftLowerArm: { z: 0.75 * crest(p, 4), y: -0.55 },
        rightLowerArm: { z: -0.75 * crest(p, 4), y: 0.55 },
        leftHand: { z: 0.25 * q },
        rightHand: { z: 0.25 * q },
        leftUpperLeg: { x: -0.1 * q2 },
        rightUpperLeg: { x: 0.1 * q2 },
        leftLowerLeg: { x: 0.2 * bend(p, 2) },
        rightLowerLeg: { x: 0.2 * crest(p, 2) },
      };
    },
    root(ctx: ClipContext) {
      const p = ctx.progress;
      return { bob: 0.025 * crest(p, 4), turn: 0.18 * wave(p, 2) };
    },
  },
  {
    id: 'dance.bounce',
    label: 'Bounce',
    category: 'dance',
    durationMs: 900,
    loop: true,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const down = bend(p, 2);
      const up = crest(p, 2);
      return {
        hips: { x: 0.06 * down, z: 0.05 * wave(p, 2) },
        spine: { x: 0.05 * down },
        chest: { x: 0.04 * down, z: 0.04 * wave(p, 2) },
        head: { x: 0.1 * down, y: 0.08 * wave(p, 2) },
        leftUpperArm: { z: -0.1 + 0.9 * up, y: -0.2 },
        rightUpperArm: { z: 0.1 - 0.9 * up, y: 0.2 },
        leftLowerArm: { y: -0.5, z: 0.25 },
        rightLowerArm: { y: 0.5, z: -0.25 },
        leftUpperLeg: { x: -0.2 * down, z: -0.05 },
        rightUpperLeg: { x: -0.2 * down, z: 0.05 },
        leftLowerLeg: { x: 0.55 * down },
        rightLowerLeg: { x: 0.55 * down },
        leftFoot: { x: 0.2 * down },
        rightFoot: { x: 0.2 * down },
      };
    },
    root(ctx: ClipContext) {
      const p = ctx.progress;
      return { bob: 0.07 * crest(p, 2) };
    },
  },
  {
    id: 'dance.wave',
    label: 'Wave dance',
    category: 'dance',
    durationMs: 1600,
    loop: true,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const s = wave(p, 2);
      const t = wave(p, 4);
      return {
        hips: { y: 0.12 * s, z: 0.1 * s },
        spine: { z: -0.05 * s },
        chest: { x: -0.05, z: 0.1 * s },
        upperChest: { z: 0.05 * s },
        neck: { z: -0.06 * s },
        head: { x: -0.08, z: -0.12 * s, y: 0.06 * s },
        leftShoulder: { z: 0.12 },
        rightShoulder: { z: -0.12 },
        leftUpperArm: { z: 2.3, y: -0.25 + 0.15 * s },
        rightUpperArm: { z: -2.3, y: 0.25 + 0.15 * s },
        leftLowerArm: { z: 0.5 + 0.4 * t, y: -0.3 },
        rightLowerArm: { z: -0.5 - 0.4 * t, y: 0.3 },
        leftHand: { z: 0.2 * t, x: 0.15 * s },
        rightHand: { z: -0.2 * t, x: -0.15 * s },
        leftUpperLeg: { z: -0.06 * s },
        rightUpperLeg: { z: -0.06 * s },
        leftLowerLeg: { x: 0.12 * bend(p, 2) },
        rightLowerLeg: { x: 0.12 * crest(p, 2) },
      };
    },
    root(ctx: ClipContext) {
      const p = ctx.progress;
      return { x: 0.07 * wave(p, 2), bob: 0.035 * crest(p, 2), turn: 0.1 * wave(p, 2) };
    },
  },
  {
    id: 'dance.twist',
    label: 'Twist',
    category: 'dance',
    durationMs: 2000,
    loop: true,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const s = wave(p, 2);
      const c = waveCos(p, 2);
      return {
        hips: { y: 0.7 * s, z: 0.06 * c },
        spine: { y: -0.35 * s },
        chest: { x: 0.05, y: -0.4 * s },
        upperChest: { y: -0.15 * s },
        neck: { y: 0.15 * s },
        head: { y: 0.35 * s, x: -0.04 },
        leftUpperArm: { z: 0.9, y: -0.35 + 0.2 * s },
        rightUpperArm: { z: -0.9, y: 0.35 + 0.2 * s },
        leftLowerArm: { y: -0.5, z: 0.35 },
        rightLowerArm: { y: 0.5, z: -0.35 },
        leftUpperLeg: { z: -0.09 * s },
        rightUpperLeg: { z: 0.09 * s },
        leftLowerLeg: { x: 0.12 * bend(p, 2) },
        rightLowerLeg: { x: 0.12 * crest(p, 2) },
      };
    },
    root(ctx: ClipContext) {
      const p = ctx.progress;
      return { bob: 0.03 * crest(p, 2), turn: 0.25 * wave(p, 2) };
    },
  },
  {
    id: 'dance.party',
    label: 'Party',
    category: 'dance',
    durationMs: 1200,
    loop: true,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const s = wave(p, 4);
      const down = bend(p, 4);
      const left = 0.5 + 0.5 * s;
      const right = 0.5 - 0.5 * s;
      return {
        hips: { y: 0.25 * s, x: 0.05 * down },
        spine: { x: 0.05 * down, y: -0.1 * s },
        chest: { x: -0.05, y: -0.12 * s },
        neck: { x: -0.05 },
        head: { x: -0.1 + 0.12 * down, y: -0.15 * s },
        leftShoulder: { z: 0.14 * left },
        rightShoulder: { z: -0.14 * right },
        leftUpperArm: { z: 0.9 + 1.1 * left, y: -0.35 },
        rightUpperArm: { z: -0.9 - 1.1 * right, y: 0.35 },
        leftLowerArm: { z: 0.3 - 0.25 * left, y: -0.35 },
        rightLowerArm: { z: -0.3 + 0.25 * right, y: 0.35 },
        leftHand: { z: 0.2 * left },
        rightHand: { z: -0.2 * right },
        leftUpperLeg: { x: -0.15 * down, z: -0.05 },
        rightUpperLeg: { x: -0.15 * down, z: 0.05 },
        leftLowerLeg: { x: 0.4 * down },
        rightLowerLeg: { x: 0.4 * down },
      };
    },
    root(ctx: ClipContext) {
      const p = ctx.progress;
      return { bob: 0.05 * crest(p, 4), turn: 0.15 * wave(p, 4), x: 0.05 * wave(p, 2) };
    },
  },
  {
    id: 'dance.happyFeet',
    label: 'Happy feet',
    category: 'dance',
    durationMs: 900,
    loop: true,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const s = wave(p, 4);
      const b = bend(p, 4, 0.25);
      const c = crest(p, 4, 0.25);
      return {
        hips: { y: 0.2 * wave(p, 2), z: 0.07 * s },
        spine: { z: -0.04 * s },
        chest: { x: 0.04, z: 0.04 * s },
        head: { y: -0.1 * s, x: 0.05 * bend(p, 4) },
        leftUpperArm: { z: 0.3 + 0.15 * s, y: -0.2 - 0.1 * s },
        rightUpperArm: { z: -0.3 + 0.15 * s, y: 0.2 - 0.1 * s },
        leftLowerArm: { y: -0.45, z: 0.3 },
        rightLowerArm: { y: 0.45, z: -0.3 },
        leftUpperLeg: { x: -0.3 * b, z: -0.08 * s },
        rightUpperLeg: { x: -0.3 * c, z: 0.08 * s },
        leftLowerLeg: { x: 0.7 * b },
        rightLowerLeg: { x: 0.7 * c },
        leftFoot: { x: 0.25 * b },
        rightFoot: { x: 0.25 * c },
      };
    },
    root(ctx: ClipContext) {
      const p = ctx.progress;
      return { bob: 0.035 * bend(p, 4), x: 0.06 * wave(p, 2) };
    },
  },
  {
    id: 'dance.spin',
    label: 'Dance spin',
    category: 'dance',
    durationMs: 2400,
    loop: true,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const s = wave(p, 2);
      const c = waveCos(p, 2);
      const out = crest(p, 1);
      return {
        hips: { y: 0.15 * s, z: 0.05 * c },
        spine: { y: -0.08 * s, x: 0.03 * out },
        chest: { y: -0.1 * s, z: 0.05 * c },
        neck: { y: -0.08 * s },
        head: { y: -0.12 * s, x: -0.05 * out },
        leftUpperArm: { z: 0.3 + 0.55 * out, y: -0.15 },
        rightUpperArm: { z: -0.3 - 0.55 * out, y: 0.15 },
        leftLowerArm: { z: 0.25 * out, y: -0.25 },
        rightLowerArm: { z: -0.25 * out, y: 0.25 },
        leftUpperLeg: { x: -0.25 * bend(p, 2), z: -0.06 },
        rightUpperLeg: { x: -0.25 * crest(p, 2), z: 0.06 },
        leftLowerLeg: { x: 0.3 * bend(p, 2) },
        rightLowerLeg: { x: 0.3 * crest(p, 2) },
      };
    },
    root(ctx: ClipContext) {
      const p = ctx.progress;
      return { turn: TAU * finite(p), bob: 0.03 * crest(p, 2), x: 0.15 * wave(p, 1) };
    },
  },

  /* ---------------------------- gesture ---------------------------- */
  {
    id: 'gesture.wave',
    label: 'Wave',
    category: 'gesture',
    durationMs: 1500,
    loop: true,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const s = wave(p, 2);
      return {
        hips: { y: 0.06 * s },
        spine: { z: 0.03 * s },
        chest: { z: 0.05 * s, x: -0.03 },
        neck: { y: 0.05 * s },
        head: { y: 0.08 * s, z: -0.05 * s, x: -0.04 },
        leftUpperArm: { z: -0.1, y: -0.05 * s },
        rightShoulder: { z: -0.1 },
        rightUpperArm: { z: -1.75, y: 0.1 + 0.08 * s },
        // A quarter turn of forearm twist (~90°) is what brings the palm from
        // edge-on (what you get with no twist) to facing the camera. The wave
        // itself is driven on X — Z swung the forearm forward/back (a pendulum
        // in the wrong plane) instead of side to side.
        rightLowerArm: { x: 0.42 * s, z: -0.55, y: 1.55 },
        rightHand: { x: 0.12 + 0.18 * s, y: -0.25 },
      };
    },
  },
  {
    id: 'gesture.waveBoth',
    label: 'Wave (both hands)',
    category: 'gesture',
    durationMs: 1600,
    loop: true,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const s = wave(p, 2);
      return {
        hips: { y: 0.08 * s },
        spine: { x: -0.03, z: -0.03 * s },
        chest: { x: -0.05, z: -0.05 * s },
        neck: { x: -0.04 },
        head: { x: -0.09, z: 0.07 * s },
        leftShoulder: { z: 0.1 },
        rightShoulder: { z: -0.1 },
        leftUpperArm: { z: 2.1, y: -0.25 },
        rightUpperArm: { z: -2.1, y: 0.25 },
        // Same treatment as `gesture.wave`: the swing is driven on X (a frontal
        // pendulum, not a forward/back one) and ±1.55 rad of forearm twist turns
        // each palm from edge-on to facing the camera.
        leftLowerArm: { x: 0.42 * s, z: 0.4, y: -1.55 },
        rightLowerArm: { x: 0.42 * s, z: -0.4, y: 1.55 },
        leftHand: { x: 0.12 + 0.18 * s, y: -0.25 },
        rightHand: { x: 0.12 + 0.18 * s, y: 0.25 },
      };
    },
  },
  {
    id: 'gesture.thumbsUp',
    label: 'Thumbs up',
    category: 'gesture',
    durationMs: 1500,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const e = hold(p, 0.08, 0.26, 0.72, 0.94);
      return {
        hips: { x: -0.03 * e },
        spine: { x: -0.04 * e },
        chest: { x: -0.05 * e, z: -0.04 * e },
        neck: { x: -0.03 * e },
        head: { x: -0.06 * e, z: -0.05 * e },
        leftUpperArm: { z: -0.08 * e },
        rightShoulder: { z: -0.06 * e },
        rightUpperArm: { z: -0.95 * e, y: 0.55 * e },
        rightLowerArm: { z: 0.55 * e, y: 0.5 * e },
        rightHand: { z: 0.3 * e, x: -0.15 * e },
      };
    },
  },
  {
    id: 'gesture.point',
    label: 'Point',
    category: 'gesture',
    durationMs: 1600,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const e = hold(p, 0.06, 0.24, 0.7, 0.94);
      return {
        hips: { y: -0.05 * e },
        spine: { y: -0.06 * e },
        chest: { y: -0.14 * e, x: -0.03 * e },
        neck: { y: -0.08 * e },
        head: { y: -0.2 * e, x: 0.04 * e },
        leftUpperArm: { z: -0.1 * e, y: -0.08 * e },
        rightShoulder: { z: -0.08 * e },
        rightUpperArm: { z: -1.15 * e, y: 0.85 * e },
        rightLowerArm: { y: 0.25 * e, z: -0.1 * e },
        rightHand: { z: 0.12 * e },
      };
    },
  },
  {
    id: 'gesture.clap',
    label: 'Clap',
    category: 'gesture',
    durationMs: 900,
    loop: true,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const c = bend(p, 4);
      return {
        hips: { x: 0.02, y: 0.05 * wave(p, 2) },
        spine: { x: 0.04 },
        chest: { x: 0.06, y: -0.04 * wave(p, 2) },
        neck: { x: -0.04 },
        head: { x: 0.05 - 0.06 * c, y: -0.05 * wave(p, 2) },
        leftShoulder: { z: 0.05 },
        rightShoulder: { z: -0.05 },
        leftUpperArm: { y: -0.8, z: 0.25, x: 0.1 },
        rightUpperArm: { y: 0.8, z: -0.25, x: 0.1 },
        leftLowerArm: { y: -0.45 - 0.25 * c, z: 0.3 * c },
        rightLowerArm: { y: 0.45 + 0.25 * c, z: -0.3 * c },
        leftHand: { z: 0.15 * c, x: 0.1 * c },
        rightHand: { z: -0.15 * c, x: 0.1 * c },
      };
    },
  },
  {
    id: 'gesture.shrug',
    label: 'Shrug',
    category: 'gesture',
    durationMs: 1600,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const e = hold(p, 0.05, 0.22, 0.68, 0.94);
      return {
        hips: { z: 0.03 * e },
        spine: { x: 0.05 * e, z: 0.03 * e },
        chest: { x: 0.05 * e },
        neck: { z: 0.08 * e, x: 0.04 * e },
        head: { z: 0.14 * e, x: 0.06 * e, y: 0.05 * e },
        leftShoulder: { z: 0.32 * e },
        rightShoulder: { z: -0.32 * e },
        leftUpperArm: { z: 0.35 * e, y: -0.25 * e },
        rightUpperArm: { z: -0.35 * e, y: 0.25 * e },
        leftLowerArm: { z: 0.4 * e, y: -1.4 * e },
        rightLowerArm: { z: -0.4 * e, y: 1.4 * e },
        // Palms roll open ("palms up") — without the twist they stay edge-on.
        leftHand: { z: 0.2 * e, x: -0.15 * e, y: -0.35 * e },
        rightHand: { z: -0.2 * e, x: -0.15 * e, y: 0.35 * e },
      };
    },
  },
  {
    id: 'gesture.peace',
    label: 'Peace sign',
    category: 'gesture',
    durationMs: 1500,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const e = hold(p, 0.07, 0.25, 0.72, 0.94);
      return {
        hips: { y: 0.04 * e },
        spine: { z: 0.03 * e },
        chest: { z: 0.05 * e, x: -0.04 * e },
        neck: { z: 0.04 * e },
        head: { z: 0.09 * e, x: -0.06 * e },
        leftUpperArm: { z: -0.1 * e, y: -0.08 * e },
        rightShoulder: { z: -0.1 * e },
        rightUpperArm: { z: -1.7 * e, y: 0.35 * e },
        rightLowerArm: { z: -0.3 * e, y: 0.35 * e },
        rightHand: { z: -0.15 * e, x: 0.25 * e },
      };
    },
  },
  {
    id: 'gesture.highFive',
    label: 'High five',
    category: 'gesture',
    durationMs: 1300,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const e = hold(p, 0.05, 0.2, 0.62, 0.92);
      const slap = pulse(ctx.time, 1.3);
      const recoil = -0.12 * slap;
      return {
        hips: { y: -0.06 * e },
        spine: { y: -0.08 * e },
        chest: { y: -0.12 * e, x: -0.05 * e + recoil },
        neck: { y: -0.08 * e },
        head: { y: -0.16 * e, x: -0.06 * e + recoil },
        leftUpperArm: { z: 0.12 * e, y: -0.12 * e },
        rightShoulder: { z: -0.12 * e },
        rightUpperArm: { z: -1.25 * e, y: 0.6 * e },
        rightLowerArm: { z: -0.15 * e, y: 0.1 * e },
        rightHand: { x: -0.3 * e, z: -0.2 * e },
      };
    },
  },
  {
    id: 'gesture.flex',
    label: 'Flex',
    category: 'gesture',
    durationMs: 2200,
    loop: true,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const s = wave(p, 2);
      const c = waveCos(p, 2);
      return {
        hips: { y: 0.12 * s },
        spine: { y: -0.06 * s },
        chest: { x: -0.06, z: 0.05 * s, y: -0.08 * s },
        neck: { y: -0.04 * s },
        head: { x: -0.05, y: 0.1 * s },
        leftShoulder: { z: 0.14 },
        rightShoulder: { z: -0.14 },
        leftUpperArm: { z: 0.95 + 0.1 * s, y: -0.35 },
        rightUpperArm: { z: -0.95 - 0.1 * s, y: 0.35 },
        leftLowerArm: { z: 0.9 + 0.12 * s, y: -0.2 },
        rightLowerArm: { z: -0.9 - 0.12 * s, y: 0.2 },
        leftHand: { z: 0.4 + 0.15 * c },
        rightHand: { z: -0.4 - 0.15 * c },
      };
    },
  },

  /* ----------------------------- emote ----------------------------- */
  {
    id: 'emote.celebrate',
    label: 'Celebrate',
    category: 'emote',
    durationMs: 2600,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const e = hold(p, 0.03, 0.16, 0.82, 0.98);
      const pump = bend(p, 3);
      const hop = Math.max(0, wave(p, 3));
      return {
        hips: { x: -0.05 * e - 0.05 * pump },
        spine: { x: -0.06 * e, z: 0.04 * e * wave(p, 2) },
        chest: { x: -0.1 * e },
        neck: { x: -0.08 * e },
        head: { x: -0.16 * e, z: 0.09 * e * wave(p, 2) },
        leftShoulder: { z: 0.16 * e },
        rightShoulder: { z: -0.16 * e },
        leftUpperArm: { z: (1.6 + 0.5 * pump) * e, y: -0.3 * e },
        rightUpperArm: { z: -(1.6 + 0.5 * pump) * e, y: 0.3 * e },
        leftLowerArm: { z: (0.3 - 0.2 * pump) * e, y: -0.25 * e },
        rightLowerArm: { z: -(0.3 - 0.2 * pump) * e, y: 0.25 * e },
        leftHand: { z: 0.2 * e },
        rightHand: { z: -0.2 * e },
        leftUpperLeg: { x: -0.15 * hop * e, z: -0.05 * e },
        rightUpperLeg: { x: -0.15 * hop * e, z: 0.05 * e },
        leftLowerLeg: { x: 0.25 * pump * e },
        rightLowerLeg: { x: 0.25 * pump * e },
      };
    },
    root(ctx: ClipContext) {
      const p = ctx.progress;
      const e = hold(p, 0.03, 0.16, 0.82, 0.98);
      const hop = Math.max(0, wave(p, 3));
      return { y: 0.16 * hop * e, bob: 0.04 * e, turn: 0.2 * wave(p, 3) * e };
    },
  },
  {
    id: 'emote.laugh',
    label: 'Laugh',
    category: 'emote',
    durationMs: 2600,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const e = hold(p, 0.04, 0.2, 0.8, 0.98);
      const shake = wave(p, 8) * e;
      const rock = wave(p, 3) * e;
      const giggle = pulse(ctx.time, 0.3) * e;
      return {
        hips: { x: 0.08 * e - 0.04 * rock },
        spine: { x: 0.1 * e - 0.08 * rock, z: 0.04 * shake },
        chest: { x: 0.12 * e - 0.06 * rock + 0.04 * giggle },
        neck: { x: -0.12 * e },
        head: { x: -0.28 * e + 0.08 * shake - 0.05 * giggle, z: 0.07 * shake },
        leftShoulder: { z: 0.06 * shake },
        rightShoulder: { z: 0.06 * shake },
        leftUpperArm: { z: 0.2 * e, y: -0.3 * e - 0.1 * shake },
        rightUpperArm: { z: -0.2 * e, y: 0.3 * e + 0.1 * shake },
        leftLowerArm: { y: -0.9 * e, z: 0.35 * e },
        rightLowerArm: { y: 0.9 * e, z: -0.35 * e },
        leftHand: { z: 0.2 * e },
        rightHand: { z: -0.2 * e },
        leftLowerLeg: { x: 0.1 * e },
        rightLowerLeg: { x: 0.1 * e },
      };
    },
    root(ctx: ClipContext) {
      const bob = -0.03 * hold(ctx.progress, 0.04, 0.2, 0.8, 0.98);
      return { bob };
    },
  },
  {
    id: 'emote.cry',
    label: 'Cry',
    category: 'emote',
    durationMs: 2800,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const e = hold(p, 0.05, 0.22, 0.78, 0.98);
      const sob = wave(p, 6) * e;
      return {
        hips: { x: 0.06 * e },
        spine: { x: 0.12 * e, z: 0.04 * sob },
        chest: { x: 0.22 * e, z: 0.03 * sob },
        upperChest: { x: 0.06 * e },
        neck: { x: 0.2 * e },
        head: { x: 0.35 * e + 0.05 * sob, z: 0.06 * e },
        leftShoulder: { z: 0.22 * e + 0.05 * sob },
        rightShoulder: { z: -0.22 * e - 0.05 * sob },
        leftUpperArm: { z: -0.25 * e, y: -0.35 * e },
        rightUpperArm: { z: 0.25 * e, y: 0.35 * e },
        leftLowerArm: { y: -1.0 * e, z: 0.5 * e, x: -0.3 * e },
        rightLowerArm: { y: 1.0 * e, z: -0.5 * e, x: -0.3 * e },
        leftHand: { z: 0.3 * e, x: 0.2 * e },
        rightHand: { z: -0.3 * e, x: 0.2 * e },
        leftLowerLeg: { x: 0.1 * e },
        rightLowerLeg: { x: 0.1 * e },
      };
    },
    root(ctx: ClipContext) {
      const e = hold(ctx.progress, 0.05, 0.22, 0.78, 0.98);
      return { bob: -0.04 * e };
    },
  },
  {
    id: 'emote.angry',
    label: 'Angry',
    category: 'emote',
    durationMs: 2200,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const e = hold(p, 0.03, 0.16, 0.8, 0.98);
      const shake = wave(p, 7) * e;
      const stomp = bend(p, 3) * e;
      return {
        hips: { x: 0.06 * e, y: 0.06 * shake, z: 0.04 * shake },
        spine: { x: 0.12 * e },
        chest: { x: 0.1 * e, z: 0.04 * shake },
        neck: { x: 0.06 * e },
        head: { x: 0.1 * e, y: 0.14 * shake, z: -0.05 * e },
        leftShoulder: { z: 0.1 * e },
        rightShoulder: { z: -0.1 * e },
        leftUpperArm: { z: -0.2 * e, y: -0.5 * e - 0.08 * shake },
        rightUpperArm: { z: 0.2 * e, y: 0.5 * e - 0.08 * shake },
        leftLowerArm: { y: -0.9 * e, z: 0.45 * e },
        rightLowerArm: { y: 0.9 * e, z: -0.45 * e },
        leftHand: { x: 0.3 * e },
        rightHand: { x: 0.3 * e },
        leftUpperLeg: { x: -0.2 * stomp, z: -0.05 * e },
        rightUpperLeg: { x: -0.2 * stomp, z: 0.05 * e },
        leftLowerLeg: { x: 0.35 * stomp },
        rightLowerLeg: { x: 0.35 * stomp },
        leftFoot: { x: 0.2 * stomp },
        rightFoot: { x: 0.2 * stomp },
      };
    },
    root(ctx: ClipContext) {
      const p = ctx.progress;
      const e = hold(p, 0.03, 0.16, 0.8, 0.98);
      return { bob: -0.03 * bend(p, 3) * e, turn: 0.1 * wave(p, 3) * e };
    },
  },
  {
    id: 'emote.surprised',
    label: 'Surprised',
    category: 'emote',
    durationMs: 1800,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const e = hold(p, 0.0, 0.1, 0.55, 0.94);
      const pop = hold(p, 0.0, 0.08, 0.26, 0.72);
      const jolt = pulse(ctx.time, 1.8) * e;
      return {
        hips: { x: 0.06 * e },
        spine: { x: -0.12 * e - 0.05 * jolt },
        chest: { x: -0.18 * e - 0.05 * jolt },
        upperChest: { x: -0.06 * e },
        neck: { x: -0.12 * e },
        head: { x: -0.2 * e - 0.06 * jolt, z: 0.05 * e },
        leftShoulder: { z: 0.2 * pop },
        rightShoulder: { z: -0.2 * pop },
        leftUpperArm: { z: 0.35 * pop, y: -0.3 * pop },
        rightUpperArm: { z: -0.35 * pop, y: 0.3 * pop },
        leftLowerArm: { z: 0.3 * pop, y: -0.45 * pop },
        rightLowerArm: { z: -0.3 * pop, y: 0.45 * pop },
        leftHand: { z: 0.35 * pop, x: -0.2 * pop },
        rightHand: { z: -0.35 * pop, x: -0.2 * pop },
        leftUpperLeg: { x: 0.12 * e },
        rightUpperLeg: { x: 0.12 * e },
        leftLowerLeg: { x: 0.18 * e },
        rightLowerLeg: { x: 0.18 * e },
      };
    },
    root(ctx: ClipContext) {
      const e = hold(ctx.progress, 0.0, 0.1, 0.55, 0.94);
      return { z: -0.05 * e, bob: 0.03 * e };
    },
  },
  {
    id: 'emote.love',
    label: 'Love',
    category: 'emote',
    durationMs: 2400,
    loop: true,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const s = wave(p, 2);
      return {
        hips: { y: 0.09 * s, z: 0.05 * s },
        spine: { x: 0.03, z: -0.03 * s },
        chest: { x: 0.04, z: 0.05 * s },
        neck: { z: -0.04 * s },
        head: { x: 0.05, z: 0.11 + 0.05 * s, y: -0.05 * s },
        leftShoulder: { z: 0.06 },
        rightShoulder: { z: -0.06 },
        leftUpperArm: { z: 0.25, y: -0.8 + 0.1 * s },
        rightUpperArm: { z: -0.25, y: 0.8 - 0.1 * s },
        leftLowerArm: { y: -0.85, z: 0.5, x: -0.2 },
        rightLowerArm: { y: 0.85, z: -0.5, x: -0.2 },
        leftHand: { z: 0.3 },
        rightHand: { z: -0.3 },
        leftLowerLeg: { x: 0.08 * crest(p, 2) },
        rightLowerLeg: { x: 0.08 * crest(p, 2) },
      };
    },
    root(ctx: ClipContext) {
      const p = ctx.progress;
      return { bob: 0.02 * crest(p, 2), x: 0.03 * wave(p, 2) };
    },
  },
  {
    id: 'emote.bored',
    label: 'Bored',
    category: 'emote',
    durationMs: 3200,
    loop: true,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const s = wave(p, 1);
      const c = waveCos(p, 1);
      return {
        hips: { x: 0.05, z: 0.07 * s, y: 0.05 * s },
        spine: { x: 0.12, z: 0.04 * s },
        chest: { x: 0.14, z: 0.05 * s },
        upperChest: { x: 0.04 },
        neck: { x: 0.1, z: 0.05 * s },
        head: { x: 0.2 + 0.05 * c, z: -0.26 + 0.08 * s, y: 0.16 * s },
        leftShoulder: { z: 0.08 },
        rightShoulder: { z: -0.16 },
        leftUpperArm: { z: -0.08, y: -0.12 - 0.05 * s },
        rightUpperArm: { z: -1.15, y: 0.55 + 0.05 * s },
        leftLowerArm: { y: -0.18 - 0.05 * s, z: 0.08 },
        rightLowerArm: { z: -0.6, y: 0.7, x: -0.2 },
        rightHand: { z: -0.25 },
      };
    },
  },

  /* ------------------------------ pose ----------------------------- */
  {
    id: 'pose.sit',
    label: 'Sit',
    category: 'pose',
    durationMs: 1800,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const e = hold(p, 0.0, 0.2, 0.8, 1);
      return {
        hips: { x: 0.12 * e },
        spine: { x: -0.06 * e },
        chest: { x: -0.05 * e },
        neck: { x: 0.03 * e },
        head: { x: 0.04 * e },
        leftUpperArm: { z: -0.06 * e, y: -0.15 * e },
        rightUpperArm: { z: 0.06 * e, y: 0.15 * e },
        leftLowerArm: { y: -0.35 * e, z: 0.12 * e },
        rightLowerArm: { y: 0.35 * e, z: -0.12 * e },
        leftUpperLeg: { x: -1.35 * e, z: -0.09 * e },
        rightUpperLeg: { x: -1.35 * e, z: 0.09 * e },
        leftLowerLeg: { x: 1.35 * e },
        rightLowerLeg: { x: 1.35 * e },
        leftFoot: { x: 0.25 * e },
        rightFoot: { x: 0.25 * e },
      };
    },
    root(ctx: ClipContext) {
      return { y: -0.42 * hold(ctx.progress, 0.0, 0.2, 0.8, 1) };
    },
  },
  {
    id: 'pose.crouch',
    label: 'Crouch',
    category: 'pose',
    durationMs: 1600,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const e = hold(p, 0.0, 0.18, 0.8, 1);
      return {
        hips: { x: 0.24 * e },
        spine: { x: 0.1 * e },
        chest: { x: 0.08 * e },
        neck: { x: -0.04 * e },
        head: { x: -0.08 * e },
        leftUpperArm: { z: 0.15 * e, y: -0.45 * e },
        rightUpperArm: { z: -0.15 * e, y: 0.45 * e },
        leftLowerArm: { y: -0.6 * e, z: 0.2 * e },
        rightLowerArm: { y: 0.6 * e, z: -0.2 * e },
        leftUpperLeg: { x: -0.95 * e, z: -0.14 * e },
        rightUpperLeg: { x: -0.95 * e, z: 0.14 * e },
        leftLowerLeg: { x: 1.2 * e },
        rightLowerLeg: { x: 1.2 * e },
        leftFoot: { x: 0.35 * e },
        rightFoot: { x: 0.35 * e },
      };
    },
    root(ctx: ClipContext) {
      return { y: -0.36 * hold(ctx.progress, 0.0, 0.18, 0.8, 1) };
    },
  },
  {
    id: 'pose.stretch',
    label: 'Stretch up',
    category: 'pose',
    durationMs: 2000,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const e = hold(p, 0.04, 0.26, 0.68, 0.96);
      const lean = wave(p, 2) * e;
      return {
        hips: { x: -0.06 * e, z: 0.04 * lean },
        spine: { x: -0.1 * e, z: 0.04 * lean },
        chest: { x: -0.12 * e, z: 0.05 * lean },
        upperChest: { x: -0.05 * e },
        neck: { x: -0.08 * e },
        head: { x: -0.16 * e, z: 0.05 * lean },
        leftShoulder: { z: 0.16 * e },
        rightShoulder: { z: -0.16 * e },
        leftUpperArm: { z: 2.4 * e, y: -0.1 * e },
        rightUpperArm: { z: -2.4 * e, y: 0.1 * e },
        leftLowerArm: { z: 0.25 * e, y: -0.1 * e },
        rightLowerArm: { z: -0.25 * e, y: 0.1 * e },
        leftUpperLeg: { z: -0.06 * e },
        rightUpperLeg: { z: 0.06 * e },
        leftLowerLeg: { x: -0.06 * e },
        rightLowerLeg: { x: -0.06 * e },
      };
    },
    root(ctx: ClipContext) {
      return { y: 0.05 * hold(ctx.progress, 0.04, 0.26, 0.68, 0.96) };
    },
  },
  {
    id: 'pose.thinking',
    label: 'Thinking',
    category: 'pose',
    durationMs: 2400,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const e = hold(p, 0.04, 0.22, 0.76, 0.98);
      const s = wave(p, 2) * e;
      return {
        hips: { z: -0.06 * e, y: -0.06 * e },
        spine: { x: 0.04 * e, z: 0.04 * e },
        chest: { x: 0.05 * e, z: 0.05 * e, y: -0.05 * e },
        neck: { z: 0.06 * e, y: 0.05 * e },
        head: { z: 0.15 * e, x: 0.08 * e + 0.03 * s, y: 0.1 * e },
        leftUpperArm: { z: 0.1 * e, y: -0.2 * e },
        leftLowerArm: { y: -0.5 * e, z: 0.2 * e },
        leftHand: { z: 0.15 * e },
        rightShoulder: { z: -0.12 * e },
        rightUpperArm: { z: -0.75 * e, y: 0.7 * e },
        rightLowerArm: { y: 1.05 * e, z: -0.4 * e, x: -0.3 * e },
        rightHand: { z: -0.25 * e, x: 0.2 * e },
        leftUpperLeg: { x: -0.06 * e },
        leftLowerLeg: { x: 0.08 * e },
      };
    },
  },
  {
    id: 'pose.leanBack',
    label: 'Lean back',
    category: 'pose',
    durationMs: 2000,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const e = hold(p, 0.04, 0.24, 0.72, 0.96);
      return {
        hips: { x: 0.12 * e },
        spine: { x: -0.2 * e },
        chest: { x: -0.15 * e },
        upperChest: { x: -0.05 * e },
        neck: { x: -0.08 * e },
        head: { x: -0.1 * e },
        leftUpperArm: { z: -0.2 * e, y: 0.25 * e },
        rightUpperArm: { z: 0.2 * e, y: -0.25 * e },
        leftLowerArm: { z: 0.15 * e, y: -0.15 * e },
        rightLowerArm: { z: -0.15 * e, y: 0.15 * e },
        leftUpperLeg: { x: 0.12 * e, z: -0.04 * e },
        rightUpperLeg: { x: 0.12 * e, z: 0.04 * e },
        leftLowerLeg: { x: 0.12 * e },
        rightLowerLeg: { x: 0.12 * e },
        leftFoot: { x: -0.1 * e },
        rightFoot: { x: -0.1 * e },
      };
    },
    root(ctx: ClipContext) {
      const e = hold(ctx.progress, 0.04, 0.24, 0.72, 0.96);
      return { z: -0.06 * e, bob: 0.02 * e };
    },
  },

  /* -------------------------- idle extra --------------------------- */
  {
    id: 'idle.lookAround',
    label: 'Look around',
    category: 'idle',
    durationMs: 4200,
    loop: true,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const y = wave(p, 1);
      const z = wave(p, 2, 0.25);
      return {
        hips: { y: 0.05 * y },
        spine: { y: 0.03 * y },
        chest: { y: 0.08 * y },
        upperChest: { y: 0.05 * y },
        neck: { y: 0.14 * y, z: 0.04 * z },
        head: { y: 0.35 * y, z: 0.08 * z, x: 0.05 * wave(p, 2) },
      };
    },
  },
  {
    id: 'idle.stretch',
    label: 'Idle stretch',
    category: 'idle',
    durationMs: 5200,
    loop: true,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const s = bend(p, 1);
      const wob = wave(p, 3) * s;
      return {
        hips: { x: -0.05 * s, z: 0.04 * wob },
        spine: { x: -0.08 * s },
        chest: { x: -0.12 * s, z: 0.04 * wob },
        neck: { x: -0.06 * s },
        head: { x: -0.12 * s, z: 0.06 * wob },
        leftShoulder: { z: 0.12 * s },
        rightShoulder: { z: -0.12 * s },
        leftUpperArm: { z: 1.9 * s, y: -0.15 * s },
        rightUpperArm: { z: -1.9 * s, y: 0.15 * s },
        leftLowerArm: { z: 0.2 * s, y: -0.1 * s },
        rightLowerArm: { z: -0.2 * s, y: 0.1 * s },
        leftLowerLeg: { x: -0.06 * s },
        rightLowerLeg: { x: -0.06 * s },
      };
    },
    root(ctx: ClipContext) {
      return { y: 0.04 * bend(ctx.progress, 1) };
    },
  },
  {
    id: 'idle.shiftWeight',
    label: 'Shift weight',
    category: 'idle',
    durationMs: 4600,
    loop: true,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const s = wave(p, 1);
      const c = waveCos(p, 1);
      return {
        hips: { x: 0.03 * c, z: 0.09 * s, y: 0.06 * s },
        spine: { z: -0.05 * s },
        chest: { z: -0.04 * s, x: 0.02 * c },
        neck: { z: 0.03 * s },
        head: { y: 0.1 * s, z: -0.05 * s },
        leftUpperArm: { z: 0.02 * s },
        rightUpperArm: { z: 0.02 * s },
        leftUpperLeg: { x: -0.07 * s, z: -0.05 * s },
        rightUpperLeg: { x: 0.07 * s, z: 0.05 * s },
        leftLowerLeg: { x: 0.12 * (0.5 - 0.5 * s) },
        rightLowerLeg: { x: 0.12 * (0.5 + 0.5 * s) },
      };
    },
    root(ctx: ClipContext) {
      const p = ctx.progress;
      return { x: 0.05 * wave(p, 1), bob: 0.015 * waveCos(p, 1) };
    },
  },

  /* ----------------------------- action ---------------------------- */
  {
    id: 'action.jump',
    label: 'Jump',
    category: 'action',
    durationMs: 1300,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const crouch = hold(p, 0, 0.1, 0.16, 0.3);
      const air = hold(p, 0.24, 0.42, 0.5, 0.7);
      const land = hold(p, 0.62, 0.72, 0.8, 0.98);
      const down = crouch + land;
      return {
        hips: { x: 0.16 * down - 0.08 * air },
        spine: { x: 0.12 * down - 0.06 * air },
        chest: { x: 0.1 * down - 0.08 * air },
        upperChest: { x: 0.03 * down },
        neck: { x: 0.04 * down - 0.08 * air },
        head: { x: 0.06 * down - 0.14 * air },
        leftShoulder: { z: 0.06 * air },
        rightShoulder: { z: -0.06 * air },
        leftUpperArm: { z: -0.2 * crouch + 1.0 * air, y: 0.35 * crouch + 0.15 * air },
        rightUpperArm: { z: 0.2 * crouch - 1.0 * air, y: -0.35 * crouch - 0.15 * air },
        leftLowerArm: { y: 0.35 * crouch - 0.3 * air, z: 0.15 * down },
        rightLowerArm: { y: -0.35 * crouch + 0.3 * air, z: -0.15 * down },
        leftUpperLeg: { x: -0.55 * crouch - 0.45 * land - 0.35 * air, z: -0.06 * down },
        rightUpperLeg: { x: -0.55 * crouch - 0.45 * land - 0.35 * air, z: 0.06 * down },
        leftLowerLeg: { x: 0.9 * crouch + 0.75 * land + 0.25 * air },
        rightLowerLeg: { x: 0.9 * crouch + 0.75 * land + 0.25 * air },
        leftFoot: { x: 0.35 * down - 0.15 * air },
        rightFoot: { x: 0.35 * down - 0.15 * air },
      };
    },
    root(ctx: ClipContext) {
      const p = ctx.progress;
      const air = hold(p, 0.24, 0.42, 0.5, 0.7);
      return { y: 0.75 * air, bob: 0.04, x: 0.1 * air };
    },
  },
  {
    id: 'action.squat',
    label: 'Squat',
    category: 'action',
    durationMs: 1700,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const e = hold(p, 0.04, 0.3, 0.62, 0.94);
      return {
        hips: { x: 0.22 * e },
        spine: { x: 0.1 * e },
        chest: { x: 0.08 * e },
        neck: { x: -0.04 * e },
        head: { x: -0.06 * e },
        leftUpperArm: { z: 0.2 * e, y: -0.5 * e },
        rightUpperArm: { z: -0.2 * e, y: 0.5 * e },
        leftLowerArm: { y: -0.6 * e, z: 0.2 * e },
        rightLowerArm: { y: 0.6 * e, z: -0.2 * e },
        leftUpperLeg: { x: -1.0 * e, z: -0.16 * e },
        rightUpperLeg: { x: -1.0 * e, z: 0.16 * e },
        leftLowerLeg: { x: 1.25 * e },
        rightLowerLeg: { x: 1.25 * e },
        leftFoot: { x: 0.35 * e },
        rightFoot: { x: 0.35 * e },
      };
    },
    root(ctx: ClipContext) {
      return { y: -0.38 * hold(ctx.progress, 0.04, 0.3, 0.62, 0.94) };
    },
  },
  {
    id: 'action.spin',
    label: 'Spin',
    category: 'action',
    durationMs: 1200,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const e = hold(p, 0.04, 0.2, 0.7, 0.94);
      const s = wave(p, 2) * e;
      return {
        hips: { y: 0.2 * s, z: 0.05 * e },
        spine: { x: 0.04 * e, y: -0.1 * s },
        chest: { y: -0.12 * s, z: 0.06 * e },
        neck: { y: -0.08 * s },
        head: { y: -0.18 * s, x: -0.05 * e },
        leftShoulder: { z: 0.1 * e },
        rightShoulder: { z: -0.1 * e },
        leftUpperArm: { z: 0.7 * e, y: -0.2 * e },
        rightUpperArm: { z: -0.7 * e, y: 0.2 * e },
        leftLowerArm: { z: 0.3 * e, y: -0.2 * e },
        rightLowerArm: { z: -0.3 * e, y: 0.2 * e },
        leftUpperLeg: { x: -0.2 * e, z: -0.08 * s },
        rightUpperLeg: { x: 0.2 * e, z: 0.08 * s },
        leftLowerLeg: { x: 0.35 * e },
        rightLowerLeg: { x: 0.25 * e },
      };
    },
    root(ctx: ClipContext) {
      const p = ctx.progress;
      const e = hold(p, 0.04, 0.2, 0.7, 0.94);
      return { turn: TAU * ramp(p, 0.06, 0.88), bob: 0.05 * e };
    },
  },
  {
    id: 'action.flip',
    label: 'Flip',
    category: 'action',
    durationMs: 1500,
    loop: false,
    pose(ctx: ClipContext) {
      const p = ctx.progress;
      const crouch = hold(p, 0, 0.08, 0.14, 0.26);
      const air = hold(p, 0.2, 0.38, 0.56, 0.76);
      const land = hold(p, 0.74, 0.84, 0.9, 1);
      const down = crouch + land;
      return {
        hips: { x: 0.2 * down + 0.2 * air },
        spine: { x: 0.12 * down + 0.45 * air },
        chest: { x: 0.1 * down + 0.4 * air },
        upperChest: { x: 0.15 * air },
        neck: { x: 0.1 * air },
        head: { x: 0.06 * down + 0.25 * air },
        leftUpperArm: { z: -0.2 * crouch + 0.3 * air, y: 0.3 * crouch - 0.75 * air },
        rightUpperArm: { z: 0.2 * crouch - 0.3 * air, y: -0.3 * crouch - 0.75 * air },
        leftLowerArm: { y: 0.3 * crouch - 0.8 * air, z: 0.2 * down },
        rightLowerArm: { y: -0.3 * crouch - 0.8 * air, z: -0.2 * down },
        leftUpperLeg: { x: -0.5 * crouch - 0.3 * land - 1.1 * air, z: -0.06 * down },
        rightUpperLeg: { x: -0.5 * crouch - 0.3 * land - 1.1 * air, z: 0.06 * down },
        leftLowerLeg: { x: 0.85 * crouch + 0.6 * land + 1.4 * air },
        rightLowerLeg: { x: 0.85 * crouch + 0.6 * land + 1.4 * air },
        leftFoot: { x: 0.3 * down },
        rightFoot: { x: 0.3 * down },
      };
    },
    root(ctx: ClipContext) {
      const p = ctx.progress;
      const air = hold(p, 0.2, 0.38, 0.56, 0.76);
      return {
        y: 0.95 * air,
        turn: TAU * ramp(p, 0.2, 0.8),
        bob: 0.05,
      };
    },
  },
] satisfies readonly AnimationClip[];

/**
 * The curated set Diggy actually ships.
 *
 * The library above is deliberately larger than the product: it is the authoring
 * palette the animations are picked from. Only these ids reach the app, so
 * adding or removing an animation is a one-line change here — nothing else in
 * the codebase needs to know.
 *
 * Selected by the user during the review pass on the demo gallery.
 */
export const SHIPPED_CLIP_IDS: readonly string[] = [
  'gesture.wave',
  'gesture.waveBoth',
  'gesture.clap',
  'gesture.shrug',
  'emote.laugh',
  'emote.surprised',
  'action.spin',
  'idle.lookAround',
];

const SHIPPED = new Set(SHIPPED_CLIP_IDS);

export const ANIMATION_CLIPS: readonly AnimationClip[] = CLIPS.filter((clip) =>
  SHIPPED.has(clip.id),
);

const CLIP_INDEX: ReadonlyMap<string, AnimationClip> = new Map(
  ANIMATION_CLIPS.map((clip) => [clip.id, clip] as const),
);

/** Look up a clip by id. Returns `undefined` for unknown ids. */
export function getClip(id: string): AnimationClip | undefined {
  return typeof id === 'string' ? CLIP_INDEX.get(id) : undefined;
}
