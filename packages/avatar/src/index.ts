/**
 * `@diggy/avatar` — the flagship VRM avatar engine.
 *
 * Framework-agnostic core ({@link AvatarEngine}) plus a thin React wrapper
 * ({@link VrmAvatar}). Everything runs on plain three.js + `@pixiv/three-vrm`.
 */

// Engine
export { AvatarEngine, DEFAULT_VRMA_DIR, discoverVrmaAssets } from './avatar-engine.js';
export type { AvatarEngineOptions } from './avatar-engine.js';

// State machine
export { AvatarStateMachine, AVATAR_STATES } from './state-machine.js';
export type {
  AvatarStateMachineOptions,
  StateChangeHandler,
} from './state-machine.js';

// Procedural idle
export { ProceduralIdle, REST_BONES, addBoneOffset } from './idle.js';
export type { BoneOffset } from './idle.js';

// Procedural animation clips (dance, gestures, emotes, poses…)
export * from './animations/index.js';

// Staging — where on screen the bot sits, and how it enters/leaves
export * from './staging.js';

// Magic dust (additive sparkle particles)
export * from './particles.js';

// Expressions
export {
  ExpressionController,
  MANAGED_EXPRESSIONS,
  MOOD_TO_VRM_EXPRESSION,
  moodToExpression,
} from './expressions.js';

// Lip-sync
export { LipSync } from './lipsync.js';
export type { AmplitudeSource } from './lipsync.js';

// React wrapper
export { VrmAvatar } from './VrmAvatar.js';
export type { VrmAvatarHandle, VrmAvatarProps } from './VrmAvatar.js';
