import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';

/** A callable that returns a 0..1 amplitude for the current frame. */
export type AmplitudeSource = () => number;

/** Resolve an `AudioContext` constructor across browsers (incl. old Safari). */
function createAudioContext(): AudioContext {
  const scope = globalThis as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Ctor) throw new Error('Web Audio API is not available in this environment');
  return new Ctor();
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Drives the VRM `aa` (mouth open) expression from either:
 *  - an {@link AnalyserNode} (Web Audio), or
 *  - a custom amplitude getter.
 *
 * `attachAudio` wires an `<audio>` element or a `MediaStream` (microphone) into
 * a local `AudioContext` + analyser. The mouth weight is damped asymmetrically
 * (fast attack, slower release) so speech looks natural.
 */
export class LipSync {
  private _vrm: VRM | null = null;
  private _analyser: AnalyserNode | null = null;
  private _data: Uint8Array<ArrayBuffer> | null = null;
  private _amplitudeSource: AmplitudeSource | null = null;
  private _context: AudioContext | null = null;
  private _weight = 0;
  private _enabled = true;
  private _gain: number;
  private _attack: number;
  private _release: number;

  constructor(options: { gain?: number; attack?: number; release?: number } = {}) {
    this._gain = options.gain ?? 3;
    this._attack = options.attack ?? 22;
    this._release = options.release ?? 9;
  }

  /** Bind to a loaded VRM. */
  attach(vrm: VRM): void {
    this._vrm = vrm;
  }

  /** Release the VRM reference. */
  detach(): void {
    this._vrm = null;
  }

  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  /** The analyser currently driving the mouth, if any. */
  get analyser(): AnalyserNode | null {
    return this._analyser;
  }

  /** The audio context used for `attachAudio`, if one was created. */
  get audioContext(): AudioContext | null {
    return this._context;
  }

  /** Current mouth-open weight (0..1). */
  get weight(): number {
    return this._weight;
  }

  /** Use a pre-built analyser node as the amplitude source. */
  setAnalyser(analyser: AnalyserNode): void {
    this._analyser = analyser;
    this._data = new Uint8Array(analyser.fftSize);
    this._amplitudeSource = null;
  }

  /** Use an arbitrary 0..1 amplitude getter as the source. */
  setAmplitudeSource(source: AmplitudeSource): void {
    this._amplitudeSource = source;
  }

  /**
   * Wire an `<audio>` element or a `MediaStream` (e.g. a mic) into an
   * `AnalyserNode`. A context is created on demand and can be resumed with
   * {@link resume}.
   */
  attachAudio(source: HTMLAudioElement | MediaStream): AnalyserNode {
    const context = this._context ?? createAudioContext();
    this._context = context;

    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;

    let node: AudioNode;
    if (typeof MediaStream !== 'undefined' && source instanceof MediaStream) {
      node = context.createMediaStreamSource(source);
    } else {
      node = context.createMediaElementSource(source as HTMLAudioElement);
      // Route through the graph so playback keeps working.
      node.connect(context.destination);
    }
    node.connect(analyser);

    this.setAnalyser(analyser);
    return analyser;
  }

  /** Resume a suspended audio context (call from a user gesture). */
  async resume(): Promise<void> {
    try {
      if (this._context && this._context.state === 'suspended') {
        await this._context.resume();
      }
    } catch {
      /* ignore — autoplay policies vary */
    }
  }

  /** Compute the current 0..1 amplitude from the configured source. */
  amplitude(): number {
    if (this._amplitudeSource) return clamp01(this._amplitudeSource());
    const analyser = this._analyser;
    if (!analyser) return 0;
    if (!this._data || this._data.length !== analyser.fftSize) {
      this._data = new Uint8Array(analyser.fftSize);
    }
    analyser.getByteTimeDomainData(this._data);
    let sum = 0;
    for (let i = 0; i < this._data.length; i += 1) {
      const v = ((this._data[i] ?? 128) - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this._data.length);
    return clamp01(rms * this._gain);
  }

  /** Advance the mouth weight and push it to the `aa` expression. */
  update(delta: number): void {
    const target = this._enabled ? this.amplitude() : 0;
    const lambda = target > this._weight ? this._attack : this._release;
    this._weight = THREE.MathUtils.damp(this._weight, target, lambda, delta);
    this._vrm?.expressionManager?.setValue('aa', this._weight);
  }

  /** Stop driving audio and close the audio context. */
  dispose(): void {
    this._data = null;
    this._analyser = null;
    this._amplitudeSource = null;
    this._weight = 0;
    const context = this._context;
    this._context = null;
    if (context && typeof context.close === 'function') {
      void context.close().catch(() => undefined);
    }
  }
}
