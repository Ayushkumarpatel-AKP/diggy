import * as THREE from 'three';
import type { AvatarMood } from '@diggy/shared';
import type { VRM, VRMExpressionPresetName } from '@pixiv/three-vrm';

/**
 * Maps a semantic {@link AvatarMood} to the VRM expression preset that best
 * represents it. `thinking` has no dedicated VRM preset, so it leans on
 * `relaxed` (the engine adds a head tilt/gesture on top of it).
 */
export const MOOD_TO_VRM_EXPRESSION: Record<AvatarMood, VRMExpressionPresetName> = {
  neutral: 'neutral',
  happy: 'happy',
  sad: 'sad',
  angry: 'angry',
  relaxed: 'relaxed',
  surprised: 'surprised',
  thinking: 'relaxed',
};

/** The full set of VRM emotion presets this controller smoothly blends. */
export const MANAGED_EXPRESSIONS: readonly VRMExpressionPresetName[] = [
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised',
  'neutral',
];

/** Resolve the VRM expression preset for a mood (never throws). */
export function moodToExpression(mood: AvatarMood | undefined): VRMExpressionPresetName {
  if (mood && mood in MOOD_TO_VRM_EXPRESSION) {
    return MOOD_TO_VRM_EXPRESSION[mood];
  }
  return 'neutral';
}

/**
 * Drives the VRM emotion presets with a smooth exponential lerp so mood changes
 * never pop. `update(delta)` must be called once per frame *before* `vrm.update`.
 */
export class ExpressionController {
  private _vrm: VRM | null = null;
  private _mood: AvatarMood = 'neutral';
  private _weights = new Map<VRMExpressionPresetName, number>();
  private _speed: number;

  /**
   * @param speed How quickly weights approach their target (lambda for
   *   `THREE.MathUtils.damp`). Larger is snappier; ~8 is a smooth blend.
   */
  constructor(speed = 8) {
    this._speed = speed;
  }

  /** Bind to a loaded VRM. Captures no state beyond the reference. */
  attach(vrm: VRM): void {
    this._vrm = vrm;
    this._weights.clear();
    for (const name of MANAGED_EXPRESSIONS) {
      this._weights.set(name, vrm.expressionManager?.getValue(name) ?? 0);
    }
  }

  /** Release the VRM reference. */
  detach(): void {
    this._vrm = null;
    this._weights.clear();
  }

  get mood(): AvatarMood {
    return this._mood;
  }

  /** The VRM preset currently being driven (may differ from `mood`). */
  get expression(): VRMExpressionPresetName {
    return moodToExpression(this._mood);
  }

  /** Set the target mood; the weight is blended in over subsequent frames. */
  setMood(mood: AvatarMood): void {
    this._mood = mood;
  }

  /** Blend every managed expression toward the current mood's target weights. */
  update(delta: number): void {
    const manager = this._vrm?.expressionManager;
    if (!manager) return;
    const target = moodToExpression(this._mood);
    for (const name of MANAGED_EXPRESSIONS) {
      const current = this._weights.get(name) ?? 0;
      const goal = name === target ? 1 : 0;
      const next = THREE.MathUtils.damp(current, goal, this._speed, delta);
      this._weights.set(name, next);
      manager.setValue(name, next);
    }
  }
}
