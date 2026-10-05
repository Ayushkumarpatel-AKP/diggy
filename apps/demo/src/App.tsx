import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { AVATAR_MODEL_PATH } from '@diggy/shared';
import type { AvatarMood, AvatarState } from '@diggy/shared';
import { VrmAvatar } from '@diggy/avatar';
import type { VrmAvatarHandle } from '@diggy/avatar';

const STATES: readonly AvatarState[] = [
  'enter',
  'idle',
  'talk',
  'listen',
  'think',
  'celebrate',
  'sad',
  'exit',
];

const MOODS: readonly AvatarMood[] = [
  'neutral',
  'happy',
  'sad',
  'angry',
  'relaxed',
  'surprised',
  'thinking',
];

type Status = 'loading' | 'ready' | 'error';
type Side = 'left' | 'right';

export function App(): ReactElement {
  const avatarRef = useRef<VrmAvatarHandle | null>(null);
  const [state, setState] = useState<AvatarState>('idle');
  const [mood, setMood] = useState<AvatarMood>('neutral');
  const [talking, setTalking] = useState(false);
  const [side, setSide] = useState<Side>('left');
  const [walkIntensity, setWalkIntensityValue] = useState(1);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);

  const handleReady = useCallback(() => {
    setStatus('ready');
    setError(null);
    // Greet by walking in from the corner once the model is ready.
    window.setTimeout(() => avatarRef.current?.walkIn(), 60);
  }, []);

  const handleError = useCallback((err: unknown) => {
    setStatus('error');
    setError(err instanceof Error ? err.message : String(err));
  }, []);

  const walkIn = useCallback((to: Side) => {
    const engine = avatarRef.current?.engine();
    engine?.setSide(to);
    // Move the resting spot synchronously *before* the walk starts, otherwise the
    // walk targets the previous corner.
    engine?.setFraming({ anchor: { x: to === 'left' ? 0.22 : 0.78, y: 0.62 } });
    setSide(to);
    setState('enter');
    avatarRef.current?.walkIn(to);
  }, []);

  const walkOut = useCallback(() => {
    setState('exit');
    avatarRef.current?.walkOut();
  }, []);

  const setWalkIntensity = useCallback((value: number) => {
    setWalkIntensityValue(value);
    avatarRef.current?.engine()?.setWalkIntensity(value);
  }, []);

  const statusLabel = useMemo(() => {
    if (status === 'ready') return 'online';
    if (status === 'error') return 'error';
    return 'loading…';
  }, [status]);

  const anchor = useMemo(() => ({ x: side === 'left' ? 0.22 : 0.78, y: 0.62 }), [side]);
  const engineOptions = useMemo(() => ({ fps: 60 }), []);

  return (
    <div className="stage">
      <div className="ink-bg" aria-hidden="true">
        <span className="blob blob-1" />
        <span className="blob blob-2" />
        <span className="blob blob-3" />
        <span className="grid" />
      </div>

      <div className="avatar-stage" aria-label="Diggy avatar">
        <VrmAvatar
          ref={avatarRef}
          className="avatar-canvas"
          modelUrl={AVATAR_MODEL_PATH}
          state={state}
          mood={mood}
          talking={talking}
          side={side}
          fitFraction={0.62}
          anchor={anchor}
          onReady={handleReady}
          onError={handleError}
          engineOptions={engineOptions}
        />
      </div>

      <header className="title">
        <h1>
          <span className="scribble">Diggy</span>
          <span className="subtitle">pocket avatar</span>
        </h1>
        <span className={`status status-${status}`}>{statusLabel}</span>
      </header>

      {status === 'error' && (
        <div className="error-card" role="alert">
          <strong>Could not load the avatar.</strong>
          <span>{error}</span>
        </div>
      )}

      <section className="controls" aria-label="Avatar controls">
        <div className="group group-inline">
          <h2>Walk</h2>
          <button type="button" className="sketch-btn" onClick={() => walkIn('left')}>
            ↙ in from left
          </button>
          <button type="button" className="sketch-btn" onClick={() => walkIn('right')}>
            ↘ in from right
          </button>
          <button type="button" className="sketch-btn" onClick={walkOut}>
            ↖ walk out
          </button>
        </div>

        <div className="group group-inline">
          <h2>Walk amount</h2>
          <input
            className="slider"
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={walkIntensity}
            onChange={(event) => setWalkIntensity(Number(event.target.value))}
            aria-label="Walk amount"
          />
          <span className="slider-value">{walkIntensity.toFixed(2)}×</span>
        </div>

        <div className="group">
          <h2>States</h2>
          <div className="buttons">
            {STATES.map((name) => (
              <button
                key={name}
                type="button"
                className={`sketch-btn${state === name ? ' is-active' : ''}`}
                onClick={() => setState(name)}
              >
                {name}
              </button>
            ))}
          </div>
        </div>

        <div className="group">
          <h2>Moods</h2>
          <div className="buttons">
            {MOODS.map((name) => (
              <button
                key={name}
                type="button"
                className={`sketch-btn mood-${name}${mood === name ? ' is-active' : ''}`}
                onClick={() => setMood(name)}
              >
                {name}
              </button>
            ))}
          </div>
        </div>

        <div className="group group-inline">
          <h2>Voice</h2>
          <button
            type="button"
            className={`sketch-btn toggle${talking ? ' is-active' : ''}`}
            aria-pressed={talking}
            onClick={() => setTalking((value) => !value)}
          >
            {talking ? '◼ talking' : '▶ talk'}
          </button>
        </div>
      </section>

      <footer className="hint">
        Pocket bot: walks in from the corner, procedural idle (breathing · auto-blink · sway), no
        animation assets required.
      </footer>
    </div>
  );
}
