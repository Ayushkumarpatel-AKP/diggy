import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';

/** An additive Euler offset (radians) applied on top of a bone's rest pose. */
export interface BoneOffset {
  x?: number;
  y?: number;
  z?: number;
}

/** The bones whose rest pose is captured so procedural motion can layer on top. */
export const REST_BONES: readonly VRMHumanBoneName[] = [
  'hips',
  'spine',
  'chest',
  'upperChest',
  'neck',
  'head',
  'leftShoulder',
  'rightShoulder',
  'leftUpperArm',
  'rightUpperArm',
  'leftLowerArm',
  'rightLowerArm',
  'leftHand',
  'rightHand',
  'leftUpperLeg',
  'rightUpperLeg',
  'leftLowerLeg',
  'rightLowerLeg',
  'leftFoot',
  'rightFoot',
];

/**
 * A natural "arms at rest" pose applied on top of the raw T-pose before any idle
 * motion or gesture, so the avatar never sits in a stiff T-pose while idling.
 * Values are Euler offsets in radians from the (T-pose) rest.
 */
export const BASE_POSE: ReadonlyArray<readonly [VRMHumanBoneName, BoneOffset]> = [
  ['leftShoulder', { z: -0.05 }],
  ['rightShoulder', { z: 0.05 }],
  ['leftUpperArm', { z: -1.32, y: -0.06 }],
  ['rightUpperArm', { z: 1.32, y: 0.06 }],
  ['leftLowerArm', { z: 0.3 }],
  ['rightLowerArm', { z: -0.3 }],
];

/** Merge `off` into an existing offset entry of `map` (summing components). */
export function addBoneOffset(
  map: Map<VRMHumanBoneName, BoneOffset>,
  name: VRMHumanBoneName,
  off: BoneOffset,
): void {
  const cur = map.get(name);
  if (!cur) {
    map.set(name, { x: off.x, y: off.y, z: off.z });
    return;
  }
  map.set(name, {
    x: (cur.x ?? 0) + (off.x ?? 0),
    y: (cur.y ?? 0) + (off.y ?? 0),
    z: (cur.z ?? 0) + (off.z ?? 0),
  });
}

/**
 * Fully procedural idle animation — it needs **no external animation asset**:
 *
 * - **Breathing** — a slow sine wave driven into the chest / spine bones.
 * - **Auto-blink** — a randomised timer that pulses the VRM `blink` expression.
 * - **Sway** — subtle secondary motion on the hips / spine / head.
 * - **Head look-at** — delegated to `vrm.lookAt` (see `AvatarEngine.setLookAtTarget`).
 *
 * Callers may pass extra additive offsets (e.g. gesture poses) which are merged
 * with the idle motion each frame. The class is safe to use detached.
 */
export class ProceduralIdle {
  private _vrm: VRM | null = null;
  private _rest = new Map<VRMHumanBoneName, THREE.Quaternion>();
  private _enabled = true;
  private _hasBlink = false;

  private _blinkTimer = 0;
  private _nextBlinkAt = 2;
  private _blinkProgress = -1;
  private _blinkWeight = 0;

  private readonly _euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly _quat = new THREE.Quaternion();
  private readonly _target = new THREE.Quaternion();
  private readonly _offsets = new Map<VRMHumanBoneName, BoneOffset>();
  /** The pose actually written to the bones, blended toward the target. */
  private readonly _output = new Map<VRMHumanBoneName, THREE.Quaternion>();
  private _transitionT = 1;
  private _transitionDur = 0.26;

  /** Bones this driver animates directly (breathing + sway + head). */
  static readonly IDLE_BONES: readonly VRMHumanBoneName[] = [
    'hips',
    'spine',
    'chest',
    'upperChest',
    'neck',
    'head',
  ];

  /** Bind to a loaded VRM and capture the rest pose of the bones we touch. */
  attach(vrm: VRM): void {
    this._vrm = vrm;
    this._rest.clear();
    this._output.clear();
    for (const name of REST_BONES) {
      const bone = vrm.humanoid.getNormalizedBoneNode(name);
      if (bone) {
        const rest = bone.quaternion.clone();
        this._rest.set(name, rest);
        this._output.set(name, rest.clone());
      }
    }
    this._hasBlink = vrm.expressionManager?.getExpression('blink') != null;
    this._transitionT = 1;
    this.reset();
  }

  /** Release the VRM reference and captured rest pose. */
  detach(): void {
    this._vrm = null;
    this._rest.clear();
    this._output.clear();
    this._offsets.clear();
  }

  /**
   * Start a smooth cross-fade into the next pose over `ms` milliseconds.
   * Call this whenever the pose mode changes (state switch, walk start/stop) so
   * bones ease into the new pose instead of snapping.
   */
  blend(ms = 260): void {
    this._transitionDur = Math.max(0.001, ms / 1000);
    this._transitionT = 0;
  }

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  get hasBlink(): boolean {
    return this._hasBlink;
  }

  /** Reset the blink scheduler. */
  reset(): void {
    this._blinkTimer = 0;
    this._nextBlinkAt = 1.5 + Math.random() * 3;
    this._blinkProgress = -1;
    this._blinkWeight = 0;
  }

  /**
   * Advance the idle animation by `delta` seconds.
   *
   * @param delta Frame delta (seconds).
   * @param elapsed Total elapsed time (seconds) used as the wave phase.
   * @param extra Optional additive bone offsets merged into the idle motion.
   */
  update(delta: number, elapsed: number, extra?: ReadonlyMap<VRMHumanBoneName, BoneOffset>): void {
    const vrm = this._vrm;
    if (!vrm) return;

    if (!this._enabled) {
      if (this._blinkWeight !== 0) {
        this._blinkWeight = 0;
        vrm.expressionManager?.setValue('blink', 0);
      }
      return;
    }

    const offsets = this._offsets;
    offsets.clear();

    // Start from the relaxed arms-at-rest pose, then layer idle motion + gestures.
    for (const [name, off] of BASE_POSE) addBoneOffset(offsets, name, off);

    const breath = Math.sin(elapsed * Math.PI * 2 * 0.22);
    const breath2 = Math.sin(elapsed * Math.PI * 2 * 0.22 + 0.7);
    const sway = Math.sin(elapsed * Math.PI * 2 * 0.07);
    const sway2 = Math.cos(elapsed * Math.PI * 2 * 0.11);
    const micro = Math.sin(elapsed * Math.PI * 2 * 0.31);
    const micro2 = Math.sin(elapsed * Math.PI * 2 * 0.47 + 1.1);

    // Layered breathing (chest leads, shoulders follow) + subtle weight shift.
    addBoneOffset(offsets, 'chest', { x: 0.02 * breath });
    addBoneOffset(offsets, 'upperChest', { x: 0.012 * breath2 });
    addBoneOffset(offsets, 'spine', { x: 0.01 * breath, z: 0.014 * sway });
    addBoneOffset(offsets, 'hips', { z: 0.012 * sway2, y: 0.02 * sway });
    addBoneOffset(offsets, 'neck', {
      x: -0.015 * breath + 0.01 * micro,
      y: 0.025 * sway,
      z: 0.012 * sway2,
    });
    addBoneOffset(offsets, 'head', {
      x: 0.012 * breath + 0.006 * micro2,
      y: 0.04 * micro,
      z: 0.014 * sway,
    });
    addBoneOffset(offsets, 'leftShoulder', { z: -0.02 * breath });
    addBoneOffset(offsets, 'rightShoulder', { z: 0.02 * breath });
    addBoneOffset(offsets, 'leftUpperArm', { z: 0.03 * breath });
    addBoneOffset(offsets, 'rightUpperArm', { z: -0.03 * breath });

    if (extra) {
      for (const [name, off] of extra) addBoneOffset(offsets, name, off);
    }

    // Smoothly cross-fade the applied pose toward the freshly computed target.
    const dt = Math.min(delta, 0.05);
    this._transitionT = Math.min(
      1,
      this._transitionT + dt / Math.max(0.001, this._transitionDur),
    );
    const k = this._transitionT * this._transitionT * (3 - 2 * this._transitionT);

    for (const name of REST_BONES) {
      const bone = vrm.humanoid.getNormalizedBoneNode(name);
      const rest = this._rest.get(name);
      if (!bone || !rest) continue;

      const off = offsets.get(name);
      this._euler.set(off?.x ?? 0, off?.y ?? 0, off?.z ?? 0, 'YXZ');
      this._quat.setFromEuler(this._euler);
      this._target.copy(rest).multiply(this._quat);

      let out = this._output.get(name);
      if (!out) {
        out = this._target.clone();
        this._output.set(name, out);
      } else {
        out.slerp(this._target, k);
      }
      bone.quaternion.copy(out);
    }

    this._updateBlink(delta, vrm);
  }

  private _updateBlink(delta: number, vrm: VRM): void {
    if (!this._hasBlink) return;
    const duration = 0.14;
    if (this._blinkProgress >= 0) {
      this._blinkProgress += delta;
      if (this._blinkProgress >= duration) {
        this._blinkProgress = -1;
        this._blinkWeight = 0;
      } else {
        this._blinkWeight = Math.sin(Math.PI * (this._blinkProgress / duration));
      }
    } else {
      this._blinkTimer += delta;
      if (this._blinkTimer >= this._nextBlinkAt) {
        this._blinkTimer = 0;
        this._nextBlinkAt = 2 + Math.random() * 4;
        this._blinkProgress = 0;
      }
    }
    vrm.expressionManager?.setValue('blink', this._blinkWeight);
  }
}
