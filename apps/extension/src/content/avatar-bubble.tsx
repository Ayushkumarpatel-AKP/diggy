/**
 * The floating in-page avatar ("pocket bot") with voice.
 *
 * Rendered into an isolated shadow root by `entrypoints/content.ts`.
 *
 * Features:
 *  - sits in a bottom corner and walks in on load
 *  - push-to-talk: hold a shortcut (default Ctrl+Shift+Space), speak, release
 *    → the background brain runs, and a speech bubble above the bot shows
 *    "Listening…" / "Thinking…" / the reply (truncated when long) and speaks it
 *  - a fill plan is confirmed inline (a small bubble with Fill / Cancel)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { VrmAvatar } from '@diggy/avatar';
import type { VrmAvatarHandle } from '@diggy/avatar';
import type { AvatarMood, AvatarState, FillInstruction, RichCard } from '@diggy/shared';
import { isAgentDelta, isAgentDone, isAgentHeard, isFillPlan, recStart, recStop } from '../../src/messages';
import { isChordRelease, matchesShortcut } from '../../src/shortcut';

export type BubbleSide = 'left' | 'right';

export type BubbleCommand =
  | { type: 'mood'; mood: AvatarMood }
  | { type: 'anim'; state: AvatarState }
  | { type: 'visible'; visible: boolean }
  | { type: 'toggle' };

type Listener = (command: BubbleCommand) => void;
const listeners = new Set<Listener>();

export const bubbleBus = {
  emit(command: BubbleCommand): void {
    for (const listener of listeners) listener(command);
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/* ------------------------------------------------------------------ *
 * Speech recognition — minimal local typings
 * ------------------------------------------------------------------ */

interface SpeechAlternative {
  transcript: string;
}
interface SpeechResult {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechAlternative;
}
interface SpeechEvent {
  results: { length: number; [index: number]: SpeechResult };
}
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => RecognitionLike;

function getRecognition(): RecognitionCtor | undefined {
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

type Phase = 'idle' | 'listening' | 'thinking' | 'reply' | 'confirm';

const MAX_BUBBLE_CHARS = 150;

export interface AvatarBubbleProps {
  modelUrl: string;
  initialVisible?: boolean;
  side?: BubbleSide;
}

export function AvatarBubble({
  modelUrl,
  initialVisible = true,
  side = 'left',
}: AvatarBubbleProps): JSX.Element {
  const avatarRef = useRef<VrmAvatarHandle | null>(null);
  const [visible, setVisible] = useState(initialVisible);
  const [mood, setMood] = useState<AvatarMood>('happy');
  const [state, setState] = useState<AvatarState>('enter');
  const [talking, setTalking] = useState(false);
  const [failed, setFailed] = useState(false);

  const [phase, setPhase] = useState<Phase>('idle');
  const [text, setText] = useState('');
  const [card, setCard] = useState<RichCard | undefined>(undefined);
  const [plan, setPlan] = useState<FillInstruction[] | null>(null);

  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [shortcut, setShortcut] = useState('Ctrl+Shift+Space');
  const [holding, setHolding] = useState(false);
  const [heard, setHeard] = useState('');

  const recognitionRef = useRef<RecognitionLike | null>(null);
  const holdingRef = useRef(false);
  const transcriptRef = useRef('');
  const hideTimerRef = useRef<number | null>(null);
  const voiceRef = useRef(true);

  voiceRef.current = voiceEnabled;

  /* --- settings ------------------------------------------------------- */

  useEffect(() => {
    const readSettings = (store: Record<string, unknown>): void => {
      const settings = store['diggy:settings'] as { voiceEnabled?: boolean; shortcut?: string } | undefined;
      if (!settings) return;
      if (typeof settings.voiceEnabled === 'boolean') setVoiceEnabled(settings.voiceEnabled);
      if (typeof settings.shortcut === 'string' && settings.shortcut) setShortcut(settings.shortcut);
    };
    void (async () => {
      try {
        readSettings((await browser.storage.local.get('diggy:settings')) as Record<string, unknown>);
      } catch {
        /* defaults are fine */
      }
    })();
    // React live when the shortcut is changed in the side panel.
    const listener = (
      changes: Record<string, { newValue?: unknown }>,
      area: string,
    ): void => {
      if (area !== 'local' || !('diggy:settings' in changes)) return;
      readSettings({ 'diggy:settings': changes['diggy:settings']?.newValue });
    };
    try {
      browser.storage.onChanged.addListener(listener);
    } catch {
      /* ignore */
    }
    return () => {
      try {
        browser.storage.onChanged.removeListener(listener);
      } catch {
        /* ignore */
      }
    };
  }, []);

  /* --- bubble bus (from the content script) --------------------------- */

  useEffect(
    () =>
      bubbleBus.subscribe((command) => {
        if (command.type === 'visible') setVisible(command.visible);
        else if (command.type === 'toggle') setVisible((current) => !current);
        else if (command.type === 'mood') setMood(command.mood);
        else if (command.type === 'anim') {
          setState(command.state);
          setTalking(command.state === 'talk');
        }
      }),
    [],
  );

  /* --- walk in whenever shown ---------------------------------------- */

  useEffect(() => {
    if (!visible) return undefined;
    const timer = window.setTimeout(() => avatarRef.current?.walkIn(side), 80);
    return () => window.clearTimeout(timer);
  }, [visible, side]);

  /* --- speaking ------------------------------------------------------- */

  const speak = useCallback((value: string) => {
    if (!voiceRef.current || typeof speechSynthesis === 'undefined') return;
    try {
      const utterance = new SpeechSynthesisUtterance(value);
      utterance.lang = /[\u0900-\u097F]/.test(value) ? 'hi-IN' : 'en-US';
      utterance.rate = 1.02;
      utterance.pitch = 1.05;
      utterance.onstart = () => {
        setTalking(true);
        setState('talk');
      };
      utterance.onend = () => {
        setTalking(false);
        setState('idle');
      };
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    } catch {
      /* speech is optional */
    }
  }, []);

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      setPhase('idle');
      setText('');
      setCard(undefined);
      setState('idle');
    }, 16000);
  }, []);

  /* --- background brain messages ------------------------------------- */

  useEffect(() => {
    const listener = (raw: unknown): undefined => {
      if (isAgentHeard(raw)) {
        // Show exactly what the mic heard (sticky — stays above the reply).
        setHeard(raw.text);
        setPhase((current) => (current === 'confirm' ? current : 'reply'));
        setText(`🗣 ${raw.text}`);
        return undefined;
      }
      if (isAgentDelta(raw)) {
        setPhase((current) => (current === 'confirm' ? current : 'reply'));
        setState('think');
        setText(raw.text);
        return undefined;
      }
      if (isAgentDone(raw)) {
        setState('idle');
        const answer = raw.text?.trim() || '…';
        setPhase('reply');
        setText(answer);
        setCard(raw.card);
        if (raw.spoke !== true) speak(answer);
        else setState('talk');
        scheduleHide();
        return undefined;
      }
      if (isFillPlan(raw)) {
        setPlan(raw.fields);
        setPhase('confirm');
        setState('idle');
        return undefined;
      }
      return undefined;
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, [speak, scheduleHide]);

  /* --- push to talk --------------------------------------------------- */

  const startListening = useCallback(async () => {
    if (holdingRef.current) return;
    holdingRef.current = true;
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    setPlan(null);
    setHeard('');
    setCard(undefined);
    setPhase('listening');
    setText('');
    setState('listen');
    try {
      // The background owns the mic (offscreen recorder) + Whisper transcription.
      const result = await recStart();
      if (!result?.ok) {
        // eslint-disable-next-line no-console
        console.warn('[Diggy] voice start failed', result);
        holdingRef.current = false;
        setHolding(false);
        setPhase('reply');
        setText(result?.error ?? 'Microphone unavailable — open the side panel and click 🎙 once.');
        scheduleHide();
        return;
      }
      setHolding(true);
    } catch (error) {
      // A rejected message must never leave the shortcut wedged on.
      holdingRef.current = false;
      setHolding(false);
      setPhase('reply');
      setText(`Voice failed: ${error instanceof Error ? error.message : String(error)}`);
      scheduleHide();
    }
  }, [scheduleHide]);

  const finishListening = useCallback(async () => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    setHolding(false);
    setPhase('thinking');
    setState('think');
    try {
      const result = await recStop();
      if (!result?.ok) {
        setPhase('reply');
        setText(result?.error ?? 'I could not hear anything — try again.');
        scheduleHide();
      }
    } catch (error) {
      setPhase('reply');
      setText(`Voice failed: ${error instanceof Error ? error.message : String(error)}`);
      scheduleHide();
    }
    // On success the background transcribes, runs the agent and streams the reply
    // back via diggy:agent-delta / diggy:agent-done.
  }, [scheduleHide]);

  useEffect(() => {
    if (!visible) return undefined;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat) return;
      if (!matchesShortcut(event, shortcut)) return;
      event.preventDefault();
      event.stopPropagation();
      void startListening();
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (!holdingRef.current) return;
      if (isChordRelease(event, shortcut)) void finishListening();
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [visible, shortcut, startListening, finishListening]);

  /* --- fill confirm --------------------------------------------------- */

  const confirmFill = useCallback(() => {
    if (!plan) return;
    void browser.runtime
      .sendMessage({ type: 'diggy:fill-apply', fields: plan })
      .then(() => {
        setPlan(null);
        setPhase('reply');
        setText(`Filled ${plan.length} field(s). Nothing was submitted.`);
        setMood('happy');
        speak(`Filled ${plan.length} fields. Nothing was submitted.`);
        scheduleHide();
      })
      .catch(() => {
        setPlan(null);
        setPhase('idle');
      });
  }, [plan, speak, scheduleHide]);

  /* --- render --------------------------------------------------------- */

  const showBubble = visible && phase !== 'idle';
  const long = text.length > MAX_BUBBLE_CHARS;
  const shown = long ? `${text.slice(0, MAX_BUBBLE_CHARS).trimEnd()}…` : text;

  return (
    <div className="diggy-bubble" data-visible={visible} data-side={side} data-failed={failed}>
      {visible ? (
        <>
          {showBubble ? (
            <div className="diggy-bubble__say" data-phase={phase} role="status" aria-live="polite">
              {phase === 'listening' ? (
                <span className="diggy-bubble__say-head">
                  <span className="diggy-bubble__mic" aria-hidden="true">
                    🎙
                  </span>{' '}
                  Listening…
                </span>
              ) : null}
              {phase === 'thinking' ? (
                <span className="diggy-bubble__say-head diggy-bubble__say-row">
                  Thinking
                  <span className="diggy-bubble__dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                </span>
              ) : null}
              {phase === 'confirm' && plan ? (
                <div className="diggy-bubble__confirm">
                  <span>
                    Fill {plan.length} field{plan.length === 1 ? '' : 's'}?
                  </span>
                  <div className="diggy-bubble__confirm-actions">
                    <button type="button" onClick={confirmFill}>
                      Fill
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setPlan(null);
                        setPhase('idle');
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
              {heard && phase !== 'confirm' && phase !== 'listening' ? (
                <span className="diggy-bubble__heard">🗣 {heard}</span>
              ) : null}
              {phase !== 'confirm' && shown ? (
                <span className="diggy-bubble__say-body">{shown}</span>
              ) : null}
              {phase !== 'confirm' && card ? (
                <a
                  className="diggy-bubble__card"
                  href={card.url ?? '#'}
                  target="_blank"
                  rel="noreferrer noopener"
                  onClick={(event) => {
                    event.preventDefault();
                    if (card.url) window.open(card.url, '_blank', 'noopener');
                  }}
                >
                  {card.image?.url || card.image?.dataUrl ? (
                    <span className="diggy-bubble__card-media">
                      <img src={card.image.url ?? card.image.dataUrl} alt="" loading="lazy" />
                      {card.kind === 'video' ? (
                        <span className="diggy-bubble__card-play" aria-hidden="true">
                          ▶
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                  <span className="diggy-bubble__card-title">
                    {card.faviconUrl ? (
                      <img className="diggy-bubble__card-favicon" src={card.faviconUrl} alt="" />
                    ) : null}
                    {card.title}
                  </span>
                  {card.subtitle ? (
                    <span className="diggy-bubble__card-sub">{card.subtitle}</span>
                  ) : null}
                </a>
              ) : null}
              {phase === 'listening' && !shown ? (
                <span className="diggy-bubble__say-body diggy-bubble__say-muted">
                  Hold {shortcut} and speak, then release.
                </span>
              ) : null}
            </div>
          ) : null}

          <span className="diggy-bubble__shadow" aria-hidden="true" />
          {failed ? (
            <span className="diggy-bubble__fallback" role="img" aria-label="Diggy">
              ◕‿◕
            </span>
          ) : (
            <VrmAvatar
              ref={avatarRef}
              modelUrl={modelUrl}
              mood={mood}
              state={state}
              talking={talking}
              side={side}
              fitFraction={0.68}
              anchor={{ x: 0.5, y: 0.62 }}
              className="diggy-bubble__canvas"
              onError={(error) => {
                console.warn('[Diggy] avatar failed to load', error);
                setFailed(true);
              }}
            />
          )}
        </>
      ) : null}
      <button
        type="button"
        className="diggy-bubble__mic"
        data-hold={holding}
        aria-label="Hold to talk"
        title={`Hold to talk (or hold ${shortcut})`}
        onPointerDown={(event) => {
          event.preventDefault();
          void startListening();
        }}
        onPointerUp={() => void finishListening()}
        onPointerLeave={() => {
          if (holdingRef.current) void finishListening();
        }}
      >
        🎙
      </button>
      <button
        type="button"
        className="diggy-bubble__toggle"
        aria-label={visible ? 'Hide Diggy' : 'Show Diggy'}
        title={visible ? 'Hide Diggy' : 'Show Diggy'}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? '×' : '◕'}
      </button>
    </div>
  );
}

/** Self-contained CSS injected into the bubble's shadow root. */
export const BUBBLE_STYLES = `
.diggy-bubble {
  --diggy-ink: #1b1917;
  position: fixed;
  bottom: 0;
  width: 232px;
  height: 312px;
  z-index: 2147483600;
  pointer-events: none;
  font-family: ui-rounded, 'Segoe UI', system-ui, sans-serif;
}
.diggy-bubble[data-side='left'] { left: 10px; }
.diggy-bubble[data-side='right'] { right: 10px; }
.diggy-bubble[data-visible='false'] { width: 36px; height: 36px; bottom: 12px; }
.diggy-bubble[data-visible='false'][data-side='left'] { left: 12px; }
.diggy-bubble[data-visible='false'][data-side='right'] { right: 12px; }
.diggy-bubble__canvas { display: block; width: 100%; height: 100%; }
.diggy-bubble__shadow {
  position: absolute;
  left: 50%;
  bottom: 6px;
  width: 96px;
  height: 20px;
  transform: translateX(-50%);
  border-radius: 50%;
  background: radial-gradient(50% 50% at 50% 50%, rgba(0, 0, 0, 0.26), rgba(0, 0, 0, 0));
  pointer-events: none;
}
.diggy-bubble__fallback {
  display: flex; align-items: center; justify-content: center;
  width: 100%; height: 100%; font-size: 40px; color: var(--diggy-ink);
}
.diggy-bubble__say {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  width: max-content;
  max-width: 258px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 12px;
  pointer-events: auto;
  background: #fffdf7;
  color: var(--diggy-ink);
  border: 2px solid var(--diggy-ink);
  border-radius: 14px 14px 14px 4px;
  box-shadow: 3px 3px 0 rgba(27, 25, 23, 0.85);
  font-size: 13px;
  line-height: 1.35;
  animation: diggy-say-in 180ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
.diggy-bubble__card {
  display: flex;
  flex-direction: column;
  margin-top: 3px;
  overflow: hidden;
  color: inherit;
  text-decoration: none;
  background: #fff;
  border: 2px solid var(--diggy-ink);
  border-radius: 10px;
}
.diggy-bubble__card-media {
  position: relative;
  display: block;
  aspect-ratio: 16 / 9;
  background: #f0ece4;
}
.diggy-bubble__card-media img { display: block; width: 100%; height: 100%; object-fit: cover; }
.diggy-bubble__card-play {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 24px;
  text-shadow: 0 1px 8px rgba(0, 0, 0, 0.75);
}
.diggy-bubble__card-title {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 7px 0;
  font-size: 12px;
  font-weight: 700;
  line-height: 1.25;
  max-height: 46px;
  overflow: hidden;
}
.diggy-bubble__card-favicon { flex: none; width: 14px; height: 14px; border-radius: 3px; }
.diggy-bubble__card-sub { padding: 0 7px 6px; font-size: 11px; opacity: 0.7; }
.diggy-bubble__say-head { font-weight: 700; opacity: 0.85; font-size: 12px; }
.diggy-bubble__say-row { display: inline-flex; align-items: center; gap: 5px; }
.diggy-bubble__say-body { white-space: pre-wrap; }
.diggy-bubble__say-muted { opacity: 0.65; }
.diggy-bubble__heard {
  font-size: 11px;
  opacity: 0.7;
  border-left: 2px solid rgba(27, 25, 23, 0.35);
  padding-left: 5px;
}
.diggy-bubble__say::after {
  content: '';
  position: absolute;
  bottom: -7px;
  left: 26px;
  width: 12px;
  height: 12px;
  background: #fffdf7;
  border-right: 2px solid var(--diggy-ink);
  border-bottom: 2px solid var(--diggy-ink);
  transform: rotate(45deg);
}
.diggy-bubble__mic { animation: diggy-pulse 1.2s ease-in-out infinite; }
.diggy-bubble__dots { display: inline-flex; gap: 3px; }
.diggy-bubble__dots i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.3;
  animation: diggy-dot 1s ease-in-out infinite;
}
.diggy-bubble__dots i:nth-child(2) { animation-delay: 0.15s; }
.diggy-bubble__dots i:nth-child(3) { animation-delay: 0.3s; }
@keyframes diggy-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
@keyframes diggy-dot {
  0%, 80%, 100% { opacity: 0.25; transform: translateY(0); }
  40% { opacity: 1; transform: translateY(-2px); }
}
.diggy-bubble__confirm { display: flex; flex-direction: column; gap: 7px; }
.diggy-bubble__confirm-actions { display: flex; gap: 6px; }
.diggy-bubble__confirm-actions button {
  font: inherit; font-size: 12px; font-weight: 700;
  padding: 4px 12px; cursor: pointer;
  border: 2px solid var(--diggy-ink); border-radius: 9px;
  background: #ffd166; color: var(--diggy-ink);
  box-shadow: 1.5px 1.5px 0 rgba(27, 25, 23, 0.9);
}
.diggy-bubble__confirm-actions button:last-child { background: #fff; }
.diggy-bubble__confirm-actions button:active { transform: translateY(1px); }
.diggy-bubble__toggle {
  position: absolute; bottom: 2px; right: 0;
  width: 24px; height: 24px; padding: 0;
  pointer-events: auto; cursor: pointer;
  border: 2px solid var(--diggy-ink); border-radius: 50%;
  background: #ffd166; color: var(--diggy-ink); font-size: 13px; line-height: 1;
  opacity: 0.3; box-shadow: 1px 1px 0 0 rgba(27, 25, 23, 0.5);
  transition: opacity 200ms ease, transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
.diggy-bubble__toggle:hover { opacity: 1; transform: translateY(-1px) rotate(-4deg); }
.diggy-bubble__toggle:active { transform: scale(0.94); }
.diggy-bubble__mic {
  position: absolute;
  bottom: 2px;
  right: 28px;
  width: 26px;
  height: 26px;
  padding: 0;
  pointer-events: auto;
  cursor: pointer;
  border: 2px solid var(--diggy-ink);
  border-radius: 50%;
  background: #cfe8ff;
  color: var(--diggy-ink);
  font-size: 13px;
  line-height: 1;
  opacity: 0.55;
  box-shadow: 1px 1px 0 0 rgba(27, 25, 23, 0.5);
  transition: opacity 200ms ease, transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
.diggy-bubble__mic:hover { opacity: 1; }
.diggy-bubble__mic[data-hold='true'] {
  background: #ff9db3;
  opacity: 1;
  transform: scale(1.08);
}
@keyframes diggy-say-in {
  0% { transform: translateX(-50%) translateY(6px) scale(0.94); opacity: 0; }
  100% { transform: translateX(-50%) translateY(0) scale(1); opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .diggy-bubble__say { animation: none; }
  .diggy-bubble__toggle { transition: none; }
}
`;
