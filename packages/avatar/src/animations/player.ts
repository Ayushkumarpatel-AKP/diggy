import type { VRMHumanBoneName } from '@pixiv/three-vrm';
import type { BoneOffset } from '../idle.js';
import { getClip, type AnimationClip, type ClipContext } from './clips.js';

/** Options accepted by `ClipPlayer`. */
export interface ClipPlayerOptions {
  /** Cross-fade duration for the clip weight, in milliseconds. Default 260. */
  blendMs?: number;
  /** Global amplitude scale applied to every returned offset. Default 1. */
  intensity?: number;
}

function zeroRoot(): { x: number; y: number; z: number; turn: number; bob: number } {
  return { x: 0, y: 0, z: 0, turn: 0, bob: 0 };
}

function finite(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Plays one `AnimationClip` at a time out of the library in `./clips.js` and
 * converts it into additive `BoneOffset`s for the avatar's humanoid bones.
 *
 * - `play(id)` cross-fades the clip weight in over `blendMs` (default 260).
 * - `stop()` fades the weight back out; `playing` stays true until the fade has
 *   finished, then the clip is released and `playing` becomes false.
 * - A non-looping clip that reaches its end holds its last frame and then fades
 *   out on its own.
 * - Every returned offset is scaled by `weight * intensity`, so the player can
 *   be layered on top of `ProceduralIdle` without any extra bookkeeping.
 * - The player never throws: unknown ids return `false` and malformed numbers
 *   are treated as 0.
 */
export class ClipPlayer {
  private _clip: AnimationClip | null = null;
  /** Seconds into the current clip. */
  private _time = 0;
  /** 0…1 blend weight currently applied to the pose. */
  private _weight = 0;
  /** True once the clip is fading out (explicit stop or natural finish). */
  private _stopping = false;
  private _blendMs: number;
  private _intensity: number;

  constructor(options: ClipPlayerOptions = {}) {
    const blend = finite(options?.blendMs ?? 260);
    this._blendMs = clamp(blend, 0, 10_000);
    this._intensity = clamp(finite(options?.intensity ?? 1), 0, 4);
  }

  /** The id of the clip currently owned by the player, if any. */
  get currentId(): string | undefined {
    return this._clip?.id;
  }

  /** Whether a clip is active (including while it fades out). */
  get playing(): boolean {
    return this._clip !== null;
  }

  /** Current blend weight, 0…1. */
  get weight(): number {
    return this._weight;
  }

  /** Start `id` from the top, fading in over `blendMs`. Returns false if unknown. */
  play(id: string): boolean {
    const clip = typeof id === 'string' ? getClip(id) : undefined;
    if (!clip) return false;
    this._clip = clip;
    this._time = 0;
    this._stopping = false;
    this._weight = 0;
    return true;
  }

  /**
   * Fade the current clip out. The pointer is released once the weight reaches
   * 0; calling `stop()` with nothing playing is a no-op.
   */
  stop(): void {
    if (!this._clip) {
      this._weight = 0;
      this._stopping = false;
      return;
    }
    this._stopping = true;
  }

  /** Scale every returned offset (and root motion) by `value` (clamped 0…4). */
  setIntensity(value: number): void {
    this._intensity = clamp(finite(value), 0, 4);
  }

  /**
   * Advance the clip by `deltaSeconds` (clamped to 0.05) and return the
   * weighted additive bone offsets for this frame. The map is empty while the
   * player is idle.
   */
  update(deltaSeconds: number): Map<VRMHumanBoneName, BoneOffset> {
    const out = new Map<VRMHumanBoneName, BoneOffset>();
    const dt = clamp(finite(deltaSeconds), 0, 0.05);

    this._advanceWeight(dt);

    const clip = this._clip;
    if (!clip) {
      this._weight = 0;
      this._time = 0;
      this._stopping = false;
      return out;
    }

    const duration = clip.durationMs / 1000;
    if (!this._stopping) {
      this._time += dt;
      if (duration > 0) {
        if (this._time >= duration) {
          if (clip.loop) this._time = this._time % duration;
          else {
            this._time = duration;
            // Non-looping clip finished: hold the last frame and fade out.
            this._stopping = true;
          }
        }
      }
    }

    const scale = this._weight * this._intensity;
    if (scale <= 0) {
      if (this._stopping) this._release();
      return out;
    }

    const sample = this._sample(clip);
    let pose: Partial<Record<VRMHumanBoneName, BoneOffset>> = {};
    try {
      pose = clip.pose(sample) ?? {};
    } catch {
      pose = {};
    }

    for (const key of Object.keys(pose) as VRMHumanBoneName[]) {
      const off = pose[key];
      if (!off) continue;
      const x = finite(off.x) * scale;
      const y = finite(off.y) * scale;
      const z = finite(off.z) * scale;
      if (x === 0 && y === 0 && z === 0) continue;
      out.set(key, { x, y, z });
    }

    return out;
  }

  /** Weighted whole-avatar motion for the current clip (zeros when idle). */
  root(): { x: number; y: number; z: number; turn: number; bob: number } {
    const clip = this._clip;
    const scale = this._weight * this._intensity;
    if (!clip || !clip.root || scale <= 0) return zeroRoot();

    const sample = this._sample(clip);
    let motion: { x?: number; y?: number; z?: number; turn?: number; bob?: number } | undefined;
    try {
      motion = clip.root(sample);
    } catch {
      motion = undefined;
    }
    return {
      x: finite(motion?.x) * scale,
      y: finite(motion?.y) * scale,
      z: finite(motion?.z) * scale,
      turn: finite(motion?.turn) * scale,
      bob: finite(motion?.bob) * scale,
    };
  }

  /* ----------------------------- internals ----------------------------- */

  private _advanceWeight(dt: number): void {
    const target = this._clip && !this._stopping ? 1 : 0;
    const duration = this._blendMs / 1000;
    if (duration <= 0) {
      this._weight = target;
      return;
    }
    const step = dt / duration;
    if (target > this._weight) this._weight = Math.min(target, this._weight + step);
    else if (target < this._weight) this._weight = Math.max(target, this._weight - step);
  }

  private _release(): void {
    this._clip = null;
    this._time = 0;
    this._weight = 0;
    this._stopping = false;
  }

  /** Sampling context for the current clip (progress is loop-safe). */
  private _sample(clip: AnimationClip): ClipContext {
    const duration = clip.durationMs / 1000;
    if (!(duration > 0)) return { time: this._time, progress: 0 };
    if (!clip.loop) {
      return { time: this._time, progress: clamp(this._time / duration, 0, 1) };
    }
    const t = ((this._time % duration) + duration) % duration;
    return { time: t, progress: t / duration };
  }
}
