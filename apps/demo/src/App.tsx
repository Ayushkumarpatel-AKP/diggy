import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { AVATAR_MODEL_PATH } from '@diggy/shared';
import type { AvatarMood, AvatarState } from '@diggy/shared';
import { ANIMATION_CLIPS, STAGE_LIST, VrmAvatar } from '@diggy/avatar';
import type { AnimationClip, VrmAvatarHandle } from '@diggy/avatar';

const MOODS: readonly AvatarMood[] = [
  'neutral',
  'happy',
  'sad',
  'angry',
  'relaxed',
  'surprised',
  'thinking',
];

const CATEGORY_ORDER: readonly AnimationClip['category'][] = [
  'entry',
  'exit',
  'dance',
  'gesture',
  'emote',
  'pose',
  'idle',
  'action',
];

const CATEGORY_ICON: Record<AnimationClip['category'], string> = {
  entry: '🚪',
  exit: '👋',
  dance: '💃',
  gesture: '🤟',
  emote: '😄',
  pose: '🧘',
  idle: '🌬',
  action: '🤸',
};

type Status = 'loading' | 'ready' | 'error';
type Side = 'left' | 'right';

const SIDE_ANCHOR: Record<Side, number> = { left: 0.22, right: 0.78 };

export function App(): ReactElement {
  const avatarRef = useRef<VrmAvatarHandle | null>(null);
  const [state, setState] = useState<AvatarState>('idle');
  const [mood, setMood] = useState<AvatarMood>('neutral');
  const [side, setSide] = useState<Side>('left');
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [activeClip, setActiveClip] = useState<string | undefined>(undefined);
  const [activeStage, setActiveStage] = useState<string>('bottomLeft');
  const [autoIdle, setAutoIdle] = useState(true);
  const [filter, setFilter] = useState<string>('all');
  /**
   * Ids the user wants to KEEP — clip ids and `mood:<name>` entries. Everything
   * not in here is a candidate for removal, so this list is the deliverable the
   * selection pass produces.
   */
  const [kept, setKept] = useState<Set<string>>(() => {
    try {
      const raw = window.localStorage.getItem('diggy.keep');
      return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set<string>();
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem('diggy.keep', JSON.stringify([...kept]));
    } catch {
      /* selection is a convenience; a full store must not break the page */
    }
  }, [kept]);

  const toggleKeep = useCallback((id: string) => {
    setKept((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const keptList = useMemo(() => [...kept].sort(), [kept]);

  const copySelection = useCallback(async () => {
    const text = keptList.join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* the textarea below is the manual fallback */
    }
  }, [keptList]);

  const grouped = useMemo(() => {
    return CATEGORY_ORDER.map((category) => ({
      category,
      clips: ANIMATION_CLIPS.filter((clip) => clip.category === category),
    })).filter((group) => group.clips.length > 0);
  }, []);

  const handleReady = useCallback(() => {
    setStatus('ready');
    setError(null);
    window.setTimeout(() => avatarRef.current?.walkIn(), 60);
  }, []);

  const handleError = useCallback((err: unknown) => {
    setStatus('error');
    setError(err instanceof Error ? err.message : String(err));
  }, []);

  const playClip = useCallback((id: string) => {
    const engine = avatarRef.current?.engine();
    if (!engine) return;
    engine.playClip(id);
    setActiveClip(id);
  }, []);

  const stopClip = useCallback(() => {
    avatarRef.current?.engine()?.stopClip();
    setActiveClip(undefined);
  }, []);

  const goToStage = useCallback(
    (name: string) => {
      const engine = avatarRef.current?.engine();
      if (!engine || !engine.setStage(name)) return;
      setActiveStage(name);
      const stage = STAGE_LIST.find((item) => item.name === name);
      if (stage) setSide(stage.x < 0.5 ? 'left' : 'right');
      setState('enter');
      avatarRef.current?.walkIn(stage && stage.x < 0.5 ? 'left' : 'right');
    },
    [],
  );

  const walkIn = useCallback((to: Side) => {
    const engine = avatarRef.current?.engine();
    engine?.setSide(to);
    // Move the resting spot synchronously *before* the walk starts, otherwise the
    // walk targets the previous corner.
    engine?.setFraming({ anchor: { x: SIDE_ANCHOR[to], y: 0.62 } });
    setSide(to);
    setState('enter');
    avatarRef.current?.walkIn(to);
  }, []);

  const walkOut = useCallback(() => {
    setState('exit');
    avatarRef.current?.walkOut();
  }, []);

  // A random idle clip between answers — the same behaviour the real bot uses.
  useEffect(() => {
    if (!autoIdle) return undefined;
    // Only the shipped animations — the rest were pruned from the palette.
    const IDLE = ['idle.lookAround', 'gesture.wave', 'gesture.waveBoth', 'gesture.clap', 'emote.laugh'];
    const timer = window.setInterval(() => {
      const pick = IDLE[Math.floor(Math.random() * IDLE.length)];
      if (pick) playClip(pick);
    }, 9000);
    return () => window.clearInterval(timer);
  }, [autoIdle, playClip]);

  const statusLabel = status === 'ready' ? 'online' : status === 'error' ? 'error' : 'loading…';
  const anchor = useMemo(() => ({ x: SIDE_ANCHOR[side], y: 0.62 }), [side]);
  const engineOptions = useMemo(() => ({ fps: 60 }), []);
  const visibleGroups = filter === 'all' ? grouped : grouped.filter((g) => g.category === filter);

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
          <span className="subtitle">animation gallery · {ANIMATION_CLIPS.length} clips</span>
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
            ↙ in left
          </button>
          <button type="button" className="sketch-btn" onClick={() => walkIn('right')}>
            ↘ in right
          </button>
          <button type="button" className="sketch-btn" onClick={walkOut}>
            ↖ out
          </button>
          <button
            type="button"
            className={`sketch-btn toggle${autoIdle ? ' is-active' : ''}`}
            aria-pressed={autoIdle}
            onClick={() => setAutoIdle((value) => !value)}
          >
            {autoIdle ? '◼ auto idle' : '▶ auto idle'}
          </button>
        </div>

        <div className="group">
          <h2>Positions ({STAGE_LIST.length})</h2>
          <div className="buttons">
            {STAGE_LIST.map((stage) => (
              <button
                key={stage.name}
                type="button"
                className={`sketch-btn${activeStage === stage.name ? ' is-active' : ''}`}
                title={`x ${stage.x} · y ${stage.y}`}
                onClick={() => goToStage(stage.name)}
              >
                {stage.label}
              </button>
            ))}
          </div>
        </div>

        <div className="group">
          <h2>
            Animations ({ANIMATION_CLIPS.length})
            {activeClip ? <span className="now-playing">▸ {activeClip}</span> : null}
            <button type="button" className="sketch-btn" onClick={stopClip}>
              stop
            </button>
          </h2>
          <div className="buttons">
            <button
              type="button"
              className={`sketch-btn${filter === 'all' ? ' is-active' : ''}`}
              onClick={() => setFilter('all')}
            >
              all
            </button>
            {grouped.map((group) => (
              <button
                key={group.category}
                type="button"
                className={`sketch-btn${filter === group.category ? ' is-active' : ''}`}
                onClick={() => setFilter(group.category)}
              >
                {CATEGORY_ICON[group.category]} {group.category} ({group.clips.length})
              </button>
            ))}
          </div>
        </div>

        {visibleGroups.map((group) => (
          <div className="group" key={group.category}>
            <h2>
              {CATEGORY_ICON[group.category]} {group.category}
              <span className="now-playing">
                {group.clips.filter((clip) => kept.has(clip.id)).length}/{group.clips.length} kept
              </span>
            </h2>
            <div className="buttons">
              {group.clips.map((clip) => (
                <span className="clip-row" key={clip.id}>
                  <button
                    type="button"
                    className={`sketch-btn keep${kept.has(clip.id) ? ' is-active' : ''}`}
                    title={kept.has(clip.id) ? 'Kept — click to drop' : 'Keep this animation'}
                    aria-pressed={kept.has(clip.id)}
                    onClick={() => toggleKeep(clip.id)}
                  >
                    {kept.has(clip.id) ? '★' : '☆'}
                  </button>
                  <button
                    type="button"
                    className={`sketch-btn${activeClip === clip.id ? ' is-active' : ''}`}
                    title={`${clip.id} · ${clip.loop ? 'loop' : 'once'} · ${clip.durationMs}ms`}
                    onClick={() => playClip(clip.id)}
                  >
                    {clip.label}
                  </button>
                </span>
              ))}
            </div>
          </div>
        ))}

        <div className="group">
          <h2>
            Moods
            <span className="now-playing">
              {MOODS.filter((name) => kept.has(`mood:${name}`)).length}/{MOODS.length} kept
            </span>
          </h2>
          <div className="buttons">
            {MOODS.map((name) => (
              <span className="clip-row" key={name}>
                <button
                  type="button"
                  className={`sketch-btn keep${kept.has(`mood:${name}`) ? ' is-active' : ''}`}
                  title={kept.has(`mood:${name}`) ? 'Kept — click to drop' : 'Keep this expression'}
                  aria-pressed={kept.has(`mood:${name}`)}
                  onClick={() => toggleKeep(`mood:${name}`)}
                >
                  {kept.has(`mood:${name}`) ? '★' : '☆'}
                </button>
                <button
                  type="button"
                  className={`sketch-btn mood-${name}${mood === name ? ' is-active' : ''}`}
                  onClick={() => setMood(name)}
                >
                  {name}
                </button>
              </span>
            ))}
          </div>
        </div>

        <div className="group">
          <h2>
            Selection
            <span className="now-playing">{keptList.length} kept</span>
            <button type="button" className="sketch-btn" onClick={() => void copySelection()}>
              copy list
            </button>
            <button
              type="button"
              className="sketch-btn"
              onClick={() => setKept(new Set(ANIMATION_CLIPS.map((clip) => clip.id)))}
            >
              keep all clips
            </button>
            <button
              type="button"
              className="sketch-btn"
              onClick={() => setKept(new Set(MOODS.map((name) => `mood:${name}`)))}
            >
              keep all moods
            </button>
            <button type="button" className="sketch-btn" onClick={() => setKept(new Set())}>
              clear
            </button>
          </h2>
          <textarea
            className="keep-output"
            readOnly
            rows={6}
            value={keptList.join('\n')}
            placeholder="☆ mark the animations and expressions you want to keep — the list appears here (and is saved in this browser)."
          />
        </div>
      </section>

      <footer className="hint">
        Har button ek procedural clip hai — koi animation asset nahi. Jo pasand aaye bata do, usi ko
        tune kar dunga (speed / amplitude / repeat).
      </footer>
    </div>
  );
}
