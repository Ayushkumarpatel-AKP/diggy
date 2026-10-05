import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';
import type { VRMAnimation } from '@pixiv/three-vrm-animation';
import type { AvatarMood, AvatarState } from '@diggy/shared';

import { AvatarStateMachine } from './state-machine.js';
import { ExpressionController } from './expressions.js';
import { LipSync } from './lipsync.js';
import type { AmplitudeSource } from './lipsync.js';
import { ProceduralIdle, addBoneOffset } from './idle.js';
import type { BoneOffset } from './idle.js';

/** Where `.vrma` clips are looked up by default (served from the host's static dir). */
export const DEFAULT_VRMA_DIR = '/animations';

export interface AvatarEngineOptions {
  /** Target frames-per-second cap. Defaults to `60`. */
  fps?: number;
  /** Max device pixel ratio used for rendering. Defaults to `2`. */
  pixelRatio?: number;
  /** Optional solid/clear colour. `null` keeps the canvas transparent. */
  background?: THREE.ColorRepresentation | null;
  /** Initial look-at target (world space). Defaults to a point in front of the head. */
  lookAtTarget?: THREE.Vector3;
  /** Called on every avatar state transition. */
  onStateChange?: (state: AvatarState, previous: AvatarState) => void;
  /** Frame the whole body (head→feet). Defaults to `true`. */
  fullBody?: boolean;
  /** Fraction of the viewport height the body should occupy (0..1). Defaults to `0.8`. */
  fitFraction?: number;
  /** Normalised (0..1) screen position of the body centre. Defaults to `{ x: 0.5, y: 0.62 }`. */
  anchor?: { x: number; y: number };
  /** Side the avatar walks in from / out to. Defaults to `'left'`. */
  side?: 'left' | 'right';
  /** Walk exaggeration multiplier (1 = natural, 0 = no motion). Defaults to `1`. */
  walkIntensity?: number;
}

/** Tunables for the procedural walk cycle. */
const WALK = {
  /** Angular speed of the walk phase (rad/s). Natural cadence ≈ 6 rad/s. */
  cadence: 6.2,
  /** Body turn toward the travel direction (rad) — a proper side-profile walk. */
  yaw: 1.45,
  /** Approximate walking speed in metres/second (drives clip duration). */
  speed: 0.55,
  /** Vertical bob amplitude (metres). */
  bob: 0.012,
} as const;

/**
 * Discover `.vrma` clips next to a static directory by reading an optional
 * `index.json` manifest (`["greet.vrma", "wave.vrma"]`).
 *
 * The manifest is optional: an empty/missing folder resolves to `[]` instead of
 * throwing, so callers can guard on its length.
 */
export async function discoverVrmaAssets(basePath: string = DEFAULT_VRMA_DIR): Promise<string[]> {
  if (typeof fetch !== 'function') return [];
  try {
    const response = await fetch(`${basePath.replace(/\/$/, '')}/index.json`);
    if (!response.ok) return [];
    const data: unknown = await response.json();
    if (!Array.isArray(data)) return [];
    return data
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => (entry.startsWith('/') || entry.includes('://') ? entry : `${basePath.replace(/\/$/, '')}/${entry}`));
  } catch {
    return [];
  }
}

/** Procedural gesture poses layered on top of the idle motion. */
class ProceduralGesture {
  private _state: AvatarState = 'idle';
  private _time = 0;
  private _walkActive = false;
  private _walkPhase = 0;
  private _walkIntensity = 1;

  setState(state: AvatarState): void {
    this._state = state;
    this._time = 0;
  }

  /** Feed the walk controller so `enter`/`exit` play a walk cycle. */
  setWalk(active: boolean, phase: number, intensity = 1): void {
    this._walkActive = active;
    this._walkPhase = phase;
    this._walkIntensity = intensity;
  }

  update(delta: number): void {
    this._time += delta;
  }

  private _walkOffsets(map: Map<VRMHumanBoneName, BoneOffset>): void {
    const p = this._walkPhase;
    const c = Math.cos(p); // +1 when the left foot is forward (contact)
    const s = Math.sin(p);
    const k = this._walkIntensity;
    const A_THIGH = 0.3 * k;
    const B_KNEE = 0.48 * k;
    const C_ANKLE = 0.15 * k;
    const A_ARM = 0.22 * k;
    const B_ELBOW = 0.13 * k;

    // Legs — thigh swings, knee flexes through the swing/passing phase.
    addBoneOffset(map, 'leftUpperLeg', { x: A_THIGH * c, z: 0.012 * k });
    addBoneOffset(map, 'rightUpperLeg', { x: -A_THIGH * c, z: -0.012 * k });
    addBoneOffset(map, 'leftLowerLeg', { x: -B_KNEE * Math.max(0, -s) });
    addBoneOffset(map, 'rightLowerLeg', { x: -B_KNEE * Math.max(0, s) });
    addBoneOffset(map, 'leftFoot', { x: C_ANKLE * Math.max(0, s) });
    addBoneOffset(map, 'rightFoot', { x: C_ANKLE * Math.max(0, -s) });

    // Arms swing opposite to the same-side leg; elbows follow through.
    addBoneOffset(map, 'leftUpperArm', { x: -A_ARM * c });
    addBoneOffset(map, 'rightUpperArm', { x: A_ARM * c });
    addBoneOffset(map, 'leftLowerArm', { x: -(0.08 + B_ELBOW * Math.max(0, c)) });
    addBoneOffset(map, 'rightLowerArm', { x: -(0.08 + B_ELBOW * Math.max(0, -c)) });

    // Pelvis + torso: gentle hip sway, chest counter-rotation, slight lean.
    addBoneOffset(map, 'hips', { y: 0.05 * k * c, z: 0.03 * k * s, x: 0.012 * k });
    addBoneOffset(map, 'spine', { x: 0.02 * k, y: -0.02 * k * c });
    addBoneOffset(map, 'chest', { x: 0.012 * k, y: -0.03 * k * c });
    addBoneOffset(map, 'upperChest', { y: 0.015 * k * c });
    addBoneOffset(map, 'neck', { y: 0.012 * k * c });
    addBoneOffset(map, 'head', { x: -0.015 * k, y: -0.008 * k * c });
  }

  /** Build the additive bone offsets for the current gesture. */
  offsets(): Map<VRMHumanBoneName, BoneOffset> {
    const map = new Map<VRMHumanBoneName, BoneOffset>();
    const t = this._time;

    if (this._walkActive) {
      this._walkOffsets(map);
      return map;
    }

    switch (this._state) {
      case 'enter':
      case 'exit': {
        const env = Math.min(1, t / 0.3) * Math.max(0, 1 - t / 4);
        const wave = Math.sin(t * Math.PI * 2 * 1.4) * env;
        addBoneOffset(map, 'rightShoulder', { z: -0.15 * env });
        addBoneOffset(map, 'rightUpperArm', { z: -2.4 * env, y: 0.09 * env });
        addBoneOffset(map, 'rightLowerArm', { z: (-0.75 + 0.45 * wave) * env });
        addBoneOffset(map, 'rightHand', { z: 0.5 * wave });
        addBoneOffset(map, 'spine', { z: 0.04 * env });
        break;
      }
      case 'celebrate': {
        const env = Math.min(1, t / 0.25) * Math.max(0, 1 - t / 5);
        const bounce = Math.sin(t * Math.PI * 2 * 1.1) * env;
        addBoneOffset(map, 'leftUpperArm', { z: 2.55 * env, x: -0.2 * env });
        addBoneOffset(map, 'rightUpperArm', { z: -2.55 * env, x: -0.2 * env });
        addBoneOffset(map, 'leftLowerArm', { z: 0.3 * env });
        addBoneOffset(map, 'rightLowerArm', { z: -0.3 * env });
        addBoneOffset(map, 'spine', { x: -0.05 * env + 0.03 * bounce, z: 0.03 * Math.sin(t * Math.PI * 2 * 2.2) * env });
        addBoneOffset(map, 'head', { x: -0.05 * env });
        break;
      }
      case 'talk': {
        const g = Math.sin(t * 2.4);
        const g2 = Math.sin(t * 3.1 + 1);
        const nod = Math.sin(t * 1.9);
        addBoneOffset(map, 'rightUpperArm', { x: -0.25 + 0.12 * g, z: -1.5 + 0.1 * g2 });
        addBoneOffset(map, 'rightLowerArm', { x: -0.2, z: -0.35 + 0.22 * g2 });
        addBoneOffset(map, 'rightHand', { z: 0.12 * g });
        addBoneOffset(map, 'leftUpperArm', { x: 0.06 * g2, z: 0.25 + 0.05 * g2 });
        addBoneOffset(map, 'leftLowerArm', { z: 0.05 });
        addBoneOffset(map, 'head', { x: 0.04 * nod, y: 0.05 * g2, z: 0.02 * g });
        addBoneOffset(map, 'neck', { x: 0.02 * nod });
        addBoneOffset(map, 'chest', { x: 0.015 * nod });
        break;
      }
      case 'listen': {
        const nod = Math.max(0, Math.sin(t * Math.PI * 2 * 0.35)) * 0.07;
        const tilt = Math.sin(t * Math.PI * 2 * 0.12) * 0.06;
        addBoneOffset(map, 'head', { x: 0.04 + nod, y: tilt, z: 0.05 });
        addBoneOffset(map, 'neck', { x: 0.03 + nod * 0.4, z: 0.02 });
        addBoneOffset(map, 'spine', { z: 0.015 });
        addBoneOffset(map, 'hips', { z: 0.01 });
        break;
      }
      case 'think': {
        const drift = Math.sin(t * 0.8) * 0.04;
        addBoneOffset(map, 'rightUpperArm', { x: -0.5, z: -2.0 });
        addBoneOffset(map, 'rightLowerArm', { z: -1.3 });
        addBoneOffset(map, 'rightHand', { z: -0.35 });
        addBoneOffset(map, 'head', { x: -0.05 + drift, z: 0.08 });
        addBoneOffset(map, 'neck', { x: 0.07, z: 0.05 });
        break;
      }
      case 'sad': {
        const breathe = Math.sin(t * Math.PI * 2 * 0.4) * 0.015;
        addBoneOffset(map, 'head', { x: 0.12, z: 0.02 });
        addBoneOffset(map, 'neck', { x: 0.1 });
        addBoneOffset(map, 'spine', { x: 0.06 + breathe });
        addBoneOffset(map, 'chest', { x: 0.04 });
        addBoneOffset(map, 'leftUpperArm', { x: 0.08 });
        addBoneOffset(map, 'rightUpperArm', { x: 0.08 });
        break;
      }
      default:
        break;
    }

    return map;
  }
}

/**
 * Framework-agnostic VRM avatar engine.
 *
 * Owns a three.js scene (transparent WebGL renderer, an upper-body framing
 * camera and ambient + directional lights), loads a VRM via `GLTFLoader` +
 * `VRMLoaderPlugin`, and runs a capped, demand-render `requestAnimationFrame`
 * loop that updates spring bones, look-at, expressions, lip-sync and the
 * procedural idle animation every frame.
 *
 * Every public method is safe to call before `load`, and `dispose()` is
 * idempotent.
 */
export class AvatarEngine {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly stateMachine: AvatarStateMachine;

  private _renderer: THREE.WebGLRenderer | null = null;
  private _canvas: HTMLCanvasElement | null = null;
  private _vrm: VRM | null = null;
  private _mixer: THREE.AnimationMixer | null = null;
  private _vrmaAction: THREE.AnimationAction | null = null;
  private _vrmaPlaying = false;

  private readonly _clock = new THREE.Clock(false);
  private readonly _lookAtTarget = new THREE.Object3D();
  private readonly _idle = new ProceduralIdle();
  private readonly _expressions = new ExpressionController();
  private readonly _lipSync = new LipSync();
  private readonly _gesture = new ProceduralGesture();
  private readonly _options: AvatarEngineOptions;

  private _fps: number;
  private _pixelRatio: number;
  private _elapsed = 0;
  private _rafId: number | null = null;
  private _lastFrameTime = 0;
  private _resizeObserver: ResizeObserver | null = null;

  private _disposed = false;
  private _appear = 1;
  private _appearTarget = 1;
  private _talking = false;

  private _side: 'left' | 'right';
  private _visibleHeight = 1.6;
  private _visibleWidth = 1.6;
  private _homeX = 0;
  private _walking = false;
  private _walkMode: 'in' | 'out' = 'in';
  private _walkTime = 0;
  private _walkDuration = 1.2;
  private _walkFromX = 0;
  private _walkToX = 0;
  private _walkPhase = 0;
  private _walkDir = 1;
  private _yaw = 0;
  private _targetYaw = 0;
  private _fitFraction: number;
  private _anchor: { x: number; y: number };
  private _walkIntensity: number;

  constructor(options: AvatarEngineOptions = {}) {
    this._options = options;
    this._fps = Math.max(1, options.fps ?? 60);
    this._pixelRatio = Math.max(1, options.pixelRatio ?? 2);
    this._side = options.side ?? 'left';
    this._fitFraction = THREE.MathUtils.clamp(options.fitFraction ?? 0.82, 0.05, 1);
    this._anchor = options.anchor ?? { x: 0.5, y: 0.62 };
    this._walkIntensity = Math.max(0, options.walkIntensity ?? 1);

    this.scene = new THREE.Scene();
    if (options.background !== null && options.background !== undefined) {
      this.scene.background = new THREE.Color(options.background);
    }

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    this.camera.position.set(0, 1.35, 1.15);
    this.camera.lookAt(0, 1.2, 0);

    // --- Lights -----------------------------------------------------------
    const ambient = new THREE.AmbientLight(0xffffff, 1.4);
    const directional = new THREE.DirectionalLight(0xffffff, 2.2);
    directional.position.set(1.2, 2.2, 1.6);
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.6);
    fill.position.set(-1.5, 1.1, -1.2);
    this.scene.add(ambient, directional, fill);

    // --- Look-at proxy ----------------------------------------------------
    this._lookAtTarget.position.copy(options.lookAtTarget ?? new THREE.Vector3(0, 1.4, 1.2));
    this.scene.add(this._lookAtTarget);

    this.stateMachine = new AvatarStateMachine({
      onStateChange: (state, previous) => this._handleStateChange(state, previous),
    });
  }

  // --- Accessors ----------------------------------------------------------

  /** The loaded VRM, or `null` before `load` resolves. */
  get vrm(): VRM | null {
    return this._vrm;
  }

  get renderer(): THREE.WebGLRenderer | null {
    return this._renderer;
  }

  get canvas(): HTMLCanvasElement | null {
    return this._canvas;
  }

  get isLoaded(): boolean {
    return this._vrm !== null;
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  get state(): AvatarState {
    return this.stateMachine.state;
  }

  get mood(): AvatarMood {
    return this._expressions.mood;
  }

  // --- Lifecycle ----------------------------------------------------------

  /** Attach (or re-attach) the engine to a `<canvas>` and start the loop. */
  mount(canvas: HTMLCanvasElement): void {
    this._assertNotDisposed();
    if (this._canvas === canvas && this._renderer) return;
    if (this._renderer) this.unmount();

    this._canvas = canvas;
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this._renderer = renderer;

    this._resize();
    this._observeResize();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVisibilityChange);
    }
    this._startLoop();
  }

  /** Detach from the canvas, stop the loop and release the renderer. */
  unmount(): void {
    this._stopLoop();
    this._disconnectResize();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
    }
    this._renderer?.dispose();
    this._renderer = null;
    this._canvas = null;
  }

  /**
   * Load a VRM from a URL and (re)wire every sub-system to it.
   * Resolves with the loaded {@link VRM}.
   */
  async load(url: string): Promise<VRM> {
    this._assertNotDisposed();

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    if (this._disposed) throw new Error('AvatarEngine was disposed while loading');

    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) throw new Error(`The file at "${url}" is not a VRM model`);

    // Optimisations recommended by the three-vrm docs.
    VRMUtils.removeUnnecessaryJoints(gltf.scene);
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    vrm.scene.traverse((object) => {
      object.frustumCulled = false;
    });

    this._removeCurrentVrm();
    this._vrm = vrm;
    this.scene.add(vrm.scene);

    if (vrm.lookAt) {
      vrm.lookAt.autoUpdate = true;
      vrm.lookAt.target = this._lookAtTarget;
    }

    this._idle.attach(vrm);
    this._expressions.attach(vrm);
    this._lipSync.attach(vrm);
    this._gesture.setState(this.stateMachine.state);

    this._mixer = new THREE.AnimationMixer(vrm.scene);
    this._mixer.addEventListener('finished', this._onActionFinished);
    this._vrmaPlaying = false;
    this._vrmaAction = null;

    this._computeFraming();

    // Drop-in entrance.
    this._appear = 0;
    this._appearTarget = 1;

    // Re-apply the state that was requested before the model finished loading.
    this._handleStateChange(this.stateMachine.state, this.stateMachine.previous);

    // Kick the loop in case `mount` happened before `load`.
    if (this._renderer) this._startLoop();
    return vrm;
  }

  /** Dispose of everything. Idempotent and safe to call at any time. */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._talking = false;
    this._stopLoop();
    this._disconnectResize();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
    }
    this._idle.detach();
    this._expressions.detach();
    this._lipSync.detach();
    this._lipSync.dispose();
    this._mixer?.stopAllAction();
    this._mixer?.removeEventListener('finished', this._onActionFinished);
    this._mixer = null;
    this._vrmaAction = null;
    this._removeCurrentVrm();
    this._renderer?.dispose();
    this._renderer = null;
    this._canvas = null;
  }

  // --- Controls -----------------------------------------------------------

  /**
   * Point the avatar's gaze at a world-space position (e.g. the cursor or the
   * camera) via `vrm.lookAt`.
   */
  setLookAtTarget(target: THREE.Vector3 | { x: number; y: number; z: number }): void {
    if (this._disposed) return;
    this._lookAtTarget.position.set(target.x, target.y, target.z);
  }

  /** Convenience: aim the gaze at the engine's camera. */
  lookAtCamera(): void {
    this.setLookAtTarget(this.camera.position);
  }

  /** Set the target facial mood; blended in smoothly over subsequent frames. */
  setExpression(mood: AvatarMood): void {
    if (this._disposed) return;
    this._expressions.setMood(mood);
  }

  /** Transition the avatar state machine (optionally with a cross-fade duration). */
  setState(state: AvatarState, crossFadeMs?: number): void {
    if (this._disposed) return;
    if (crossFadeMs && crossFadeMs > 0) this.stateMachine.crossFadeTo(state, crossFadeMs);
    else this.stateMachine.play(state);
  }

  /** Toggle the talking behaviour (locks the `talk` state while enabled). */
  setTalking(talking: boolean): void {
    if (this._disposed) return;
    this._talking = talking;
    if (talking) this.stateMachine.play('talk');
    else if (this.stateMachine.state === 'talk') this.stateMachine.play('idle');
  }

  /** Which side the avatar walks in from / out to. */
  setSide(side: 'left' | 'right'): void {
    this._side = side;
  }

  /** Set the walk exaggeration multiplier (1 = natural, 0 = no motion). */
  setWalkIntensity(intensity: number): void {
    this._walkIntensity = Math.max(0, intensity);
  }

  /**
   * Update framing (body fit fraction and/or the normalised screen anchor) and
   * re-frame immediately — without reloading the model.
   */
  setFraming(next: { fitFraction?: number; anchor?: { x: number; y: number } }): void {
    if (this._disposed) return;
    if (next.fitFraction !== undefined) {
      this._fitFraction = THREE.MathUtils.clamp(next.fitFraction, 0.05, 1);
    }
    if (next.anchor) this._anchor = next.anchor;
    if (this._vrm) this._computeFraming();
  }

  /** Walk in from `side` (default: the configured side) to the resting spot. */
  walkIn(side: 'left' | 'right' = this._side): void {
    if (this._disposed) return;
    this._side = side;
    this.stateMachine.play('enter');
  }

  /** Walk out toward `side` (default: the configured side) and disappear. */
  walkOut(side: 'left' | 'right' = this._side): void {
    if (this._disposed) return;
    this._side = side;
    this.stateMachine.play('exit');
  }

  /**
   * Start lip-sync from an `<audio>` element, a `MediaStream`, a pre-built
   * `AnalyserNode`, or an amplitude getter. Returns the analyser (if any).
   */
  startLipSync(
    source?: HTMLAudioElement | MediaStream | AnalyserNode | AmplitudeSource,
  ): AnalyserNode | null {
    if (this._disposed || source === undefined) return this.getAudioAnalyser();
    if (typeof source === 'function') {
      this._lipSync.setAmplitudeSource(source);
    } else if (typeof AnalyserNode !== 'undefined' && source instanceof AnalyserNode) {
      this._lipSync.setAnalyser(source);
    } else {
      this._lipSync.attachAudio(source as HTMLAudioElement | MediaStream);
    }
    this._lipSync.setEnabled(true);
    return this.getAudioAnalyser();
  }

  /** The analyser currently driving lip-sync, or `null`. */
  getAudioAnalyser(): AnalyserNode | null {
    return this._lipSync.analyser;
  }

  /** Resume the lip-sync audio context (call from a user gesture). */
  async resumeAudio(): Promise<void> {
    await this._lipSync.resume();
  }

  /**
   * Play a `.vrma` animation clip. Rejects with a descriptive error if the file
   * is missing or contains no VRM animation — callers should guard with
   * {@link discoverVrmaAssets} when the asset folder may be empty.
   */
  async playVRMA(url: string): Promise<void> {
    this._assertNotDisposed();
    const vrm = this._vrm;
    if (!vrm) throw new Error('Cannot play a VRMA clip before a VRM is loaded');

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    if (this._disposed) return;

    const animations = gltf.userData.vrmAnimations as VRMAnimation[] | undefined;
    const animation = animations?.[0];
    if (!animation) throw new Error(`No VRM animation found in "${url}"`);

    const clip = createVRMAnimationClip(animation, vrm);
    if (!this._mixer) {
      this._mixer = new THREE.AnimationMixer(vrm.scene);
      this._mixer.addEventListener('finished', this._onActionFinished);
    }
    this._mixer.stopAllAction();

    const action = this._mixer.clipAction(clip);
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = false;
    action.play();

    this._vrmaAction = action;
    this._vrmaPlaying = true;
  }

  /** Stop any active `.vrma` playback. */
  stopVRMA(): void {
    this._mixer?.stopAllAction();
    this._vrmaAction = null;
    this._vrmaPlaying = false;
  }

  // --- Internals ----------------------------------------------------------

  private _handleStateChange(state: AvatarState, previous: AvatarState): void {
    this._gesture.setState(state);
    // Cross-fade the whole pose so state changes never snap.
    this._idle.blend(280);
    if (state === 'enter') {
      this._appear = 0;
      this._appearTarget = 1;
      this.stateMachine.autoReturn = false;
      this._startWalk('in');
    } else if (state === 'exit') {
      this._startWalk('out');
    } else {
      this._targetYaw = 0;
      if (state !== 'idle') this.stateMachine.autoReturn = true;
    }

    switch (state) {
      case 'celebrate':
        this._expressions.setMood('happy');
        break;
      case 'sad':
        this._expressions.setMood('sad');
        break;
      case 'think':
        this._expressions.setMood('thinking');
        break;
      default:
        break;
    }

    this._options.onStateChange?.(state, previous);
  }

  /** Begin a walk-in or walk-out from the configured side. */
  private _startWalk(mode: 'in' | 'out'): void {
    const vrm = this._vrm;
    const edgeX = (this._side === 'left' ? -1 : 1) * this._visibleWidth * 0.6;
    this._walkMode = mode;
    this._walkFromX = mode === 'in' ? edgeX : this._homeX;
    this._walkToX = mode === 'in' ? this._homeX : edgeX;
    this._walkDir = this._walkToX >= this._walkFromX ? 1 : -1;
    const distance = Math.abs(this._walkToX - this._walkFromX);
    this._walkDuration = THREE.MathUtils.clamp(distance / WALK.speed, 0.9, 2.8);
    this._walkTime = 0;
    this._walkPhase = 0;
    this._walking = true;
    this._targetYaw = this._walkDir >= 0 ? WALK.yaw : -WALK.yaw;
    this._idle.blend(220);
    if (vrm) vrm.scene.position.x = this._walkFromX;
  }

  /** Advance the walk movement + facing yaw each frame. */
  private _updateWalk(delta: number): void {
    const vrm = this._vrm;
    if (!vrm) return;

    if (!this._walking) {
      this._targetYaw = 0;
      this._yaw = THREE.MathUtils.damp(this._yaw, 0, 6, delta);
      vrm.scene.rotation.y = this._yaw;
      return;
    }

    this._walkTime += delta;
    const t = Math.min(1, this._walkTime / this._walkDuration);
    const eased = t * t * (3 - 2 * t);
    vrm.scene.position.x = THREE.MathUtils.lerp(this._walkFromX, this._walkToX, eased);
    this._walkPhase += delta * WALK.cadence;

    this._yaw = THREE.MathUtils.damp(this._yaw, this._targetYaw, 8, delta);
    vrm.scene.rotation.y = this._yaw;

    if (t >= 1) {
      this._walking = false;
      vrm.scene.position.x = this._walkToX;
      if (this._walkMode === 'in') {
        this.stateMachine.autoReturn = true;
        this.stateMachine.play('idle');
      } else {
        this._appearTarget = 0;
      }
    }
  }

  private _update(delta: number): void {
    this._elapsed += delta;
    this.stateMachine.update(delta);

    // Hold the talking state while speech is active (also refreshes its timer).
    if (this._talking && this.stateMachine.state !== 'exit') {
      this.stateMachine.play('talk');
    }
    this._gesture.update(delta);

    const vrm = this._vrm;
    if (!vrm) return;

    this._appear = THREE.MathUtils.damp(this._appear, this._appearTarget, 6, delta);
    vrm.scene.scale.setScalar(0.9 + 0.1 * this._appear);

    this._updateWalk(delta);
    // Two-beat vertical bob — lowest at each foot contact, highest at passing.
    const bob = this._walking
      ? WALK.bob * this._walkIntensity * (0.5 - 0.5 * Math.cos(2 * this._walkPhase))
      : 0;
    vrm.scene.position.y = (this._appear - 1) * 0.2 + bob;

    this._gesture.setWalk(this._walking, this._walkPhase, this._walkIntensity);

    const vrmaSafeIdle = !this._vrmaPlaying;
    this._idle.setEnabled(vrmaSafeIdle);
    if (vrmaSafeIdle) {
      this._idle.update(delta, this._elapsed, this._gesture.offsets());
    } else {
      this._idle.update(delta, this._elapsed);
    }

    this._expressions.update(delta);
    this._lipSync.update(delta);
    this._mixer?.update(delta);

    // Spring bones + look-at.
    vrm.update(delta);
  }

  private _render(): void {
    if (!this._renderer) return;
    this._renderer.render(this.scene, this.camera);
  }

  private _tick = (): void => {
    if (this._disposed) return;
    this._rafId = requestAnimationFrame(this._tick);

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const minInterval = 1000 / this._fps;
    if (this._lastFrameTime !== 0 && now - this._lastFrameTime < minInterval - 1) {
      return; // FPS cap — skip this frame
    }
    this._lastFrameTime = now;

    const delta = Math.min(this._clock.getDelta(), 0.1);
    this._update(delta);
    this._render();
  };

  private _startLoop(): void {
    if (this._disposed || this._renderer === null || this._rafId !== null) return;
    this._lastFrameTime = 0;
    this._clock.start();
    this._clock.getDelta(); // discard the time spent loading
    this._tick();
  }

  private _stopLoop(): void {
    if (this._rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this._rafId);
    }
    this._rafId = null;
    this._clock.stop();
  }

  private _computeFraming(): void {
    const vrm = this._vrm;
    if (!vrm) return;

    vrm.scene.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const height = Math.max(0.2, box.max.y - box.min.y);
    const centerY = (box.min.y + box.max.y) / 2;

    const fit = this._fitFraction;
    const visibleHeight = height / fit;
    const distance = visibleHeight / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const anchor = this._anchor;
    const lookAtY = centerY + (anchor.y - 0.5) * visibleHeight;

    this.camera.position.set(0, lookAtY, distance);
    this.camera.lookAt(0, lookAtY, 0);
    this.camera.updateProjectionMatrix();

    this._visibleHeight = visibleHeight;
    this._visibleWidth = visibleHeight * (this.camera.aspect || 1);
    this._homeX = (anchor.x - 0.5) * this._visibleWidth;

    if (!this._walking) vrm.scene.position.x = this._homeX;

    if (!this._options.lookAtTarget) {
      this._lookAtTarget.position.set(0, centerY + height * 0.12, 1.2);
    }
  }

  private _removeCurrentVrm(): void {
    const vrm = this._vrm;
    if (!vrm) return;
    this.scene.remove(vrm.scene);
    try {
      VRMUtils.deepDispose(vrm.scene);
    } catch {
      /* deepDispose is best-effort */
    }
    this._vrm = null;
  }

  private _resize(): void {
    const renderer = this._renderer;
    const canvas = this._canvas;
    if (!renderer || !canvas) return;

    const width = canvas.clientWidth || canvas.width || (typeof window !== 'undefined' ? window.innerWidth : 640);
    const height = canvas.clientHeight || canvas.height || (typeof window !== 'undefined' ? window.innerHeight : 480);

    const devicePixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    renderer.setPixelRatio(Math.min(devicePixelRatio, this._pixelRatio));
    renderer.setSize(width, height, false);

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (this._vrm) this._computeFraming();
  }

  private _observeResize(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this._resizeObserver = new ResizeObserver(() => this._resize());
    if (this._canvas) this._resizeObserver.observe(this._canvas);
  }

  private _disconnectResize(): void {
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
  }

  private _onVisibilityChange = (): void => {
    if (typeof document === 'undefined') return;
    if (document.hidden) this._stopLoop();
    else this._startLoop();
  };

  private _onActionFinished = (event: { action?: THREE.AnimationAction }): void => {
    if (this._vrmaAction && event.action === this._vrmaAction) {
      this._vrmaAction = null;
      this._vrmaPlaying = false;
      this._idle.reset();
    }
  };

  private _assertNotDisposed(): void {
    if (this._disposed) throw new Error('AvatarEngine has been disposed');
  }
}
