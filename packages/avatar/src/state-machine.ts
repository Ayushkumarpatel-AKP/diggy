import type { AvatarState } from '@diggy/shared';

/**
 * The finite set of avatar states supported by the state machine.
 * Mirrors `AvatarState` from `@diggy/shared` so it can be validated at runtime.
 */
export const AVATAR_STATES: readonly AvatarState[] = [
  'idle',
  'enter',
  'exit',
  'talk',
  'listen',
  'think',
  'celebrate',
  'sad',
];

/** States that should never auto-return to `idle`. */
const NO_AUTO_RETURN: readonly AvatarState[] = ['idle', 'exit'];

export type StateChangeHandler = (state: AvatarState, previous: AvatarState) => void;

export interface AvatarStateMachineOptions {
  /** Initial state. Defaults to `'idle'`. */
  initialState?: AvatarState;
  /** Whether non-idle states automatically return to `idle`. Defaults to `true`. */
  autoReturn?: boolean;
  /** Milliseconds before a non-idle state auto-returns to `idle`. Defaults to `4000`. */
  autoReturnMs?: number;
  /** Called whenever the active state changes. */
  onStateChange?: StateChangeHandler;
}

/**
 * A tiny, framework-agnostic finite state machine driving the avatar's
 * high level behaviour (`idle → enter ⇄ listen/talk/think/celebrate → exit`).
 *
 * It intentionally has no dependency on three.js or the DOM: the engine feeds it
 * deltas (`update`) and reacts to transitions (`onStateChange`).
 */
export class AvatarStateMachine {
  private _state: AvatarState;
  private _previous: AvatarState;
  private _elapsedMs = 0;
  private _crossFadeMs = 0;
  private _autoReturn: boolean;
  private _autoReturnMs: number;

  /** Callback invoked on every state transition. */
  onStateChange?: StateChangeHandler;

  constructor(options: AvatarStateMachineOptions = {}) {
    this._state = options.initialState ?? 'idle';
    this._previous = this._state;
    this._autoReturn = options.autoReturn ?? true;
    this._autoReturnMs = options.autoReturnMs ?? 4000;
    this.onStateChange = options.onStateChange;
  }

  /** The currently active state. */
  get state(): AvatarState {
    return this._state;
  }

  /** The state that was active before the current one. */
  get previous(): AvatarState {
    return this._previous;
  }

  /** Duration of the most recent cross-fade, in milliseconds. */
  get transitionMs(): number {
    return this._crossFadeMs;
  }

  /** Milliseconds elapsed since the last state change. */
  get elapsedMs(): number {
    return this._elapsedMs;
  }

  get isIdle(): boolean {
    return this._state === 'idle';
  }

  get autoReturn(): boolean {
    return this._autoReturn;
  }

  set autoReturn(value: boolean) {
    this._autoReturn = value;
  }

  get autoReturnMs(): number {
    return this._autoReturnMs;
  }

  set autoReturnMs(value: number) {
    this._autoReturnMs = Math.max(0, value);
  }

  /**
   * Transition to a state immediately (an optional transition duration is
   * recorded so consumers can blend into it).
   */
  play(state: AvatarState, transitionMs = 0): void {
    this._transitionTo(state, transitionMs);
  }

  /** Transition to a state with an explicit cross-fade duration, in ms. */
  crossFadeTo(state: AvatarState, ms: number): void {
    this._transitionTo(state, Math.max(0, ms));
  }

  /** Advance the auto-return timer. Call once per frame with the frame delta. */
  update(delta: number): void {
    if (!Number.isFinite(delta) || delta <= 0) return;
    this._elapsedMs += delta * 1000;
    if (!this._autoReturn) return;
    if (NO_AUTO_RETURN.includes(this._state)) return;
    if (this._elapsedMs >= this._autoReturnMs) {
      this._transitionTo('idle', this._crossFadeMs);
    }
  }

  /** Force the machine back to `idle` without notifying listeners. */
  reset(): void {
    this._previous = this._state;
    this._state = 'idle';
    this._elapsedMs = 0;
    this._crossFadeMs = 0;
  }

  private _transitionTo(state: AvatarState, transitionMs: number): void {
    this._crossFadeMs = transitionMs;
    // Re-playing the current state simply restarts its timer
    // (e.g. holding `talk` while audio keeps flowing).
    if (state === this._state) {
      this._elapsedMs = 0;
      return;
    }
    this._previous = this._state;
    this._state = state;
    this._elapsedMs = 0;
    this.onStateChange?.(state, this._previous);
  }
}
