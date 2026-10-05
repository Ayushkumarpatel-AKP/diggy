import { useEffect, useState } from 'react';
import { VrmAvatar } from '@diggy/avatar';
import { InkBackground, SketchBadge, SketchButton } from '@diggy/ui';
import { AVATAR_MODEL_PATH, type AvatarMood, type AvatarState } from '@diggy/shared';

const MOODS: AvatarMood[] = ['neutral', 'happy', 'thinking', 'surprised', 'relaxed', 'sad'];
const STATES: AvatarState[] = ['idle', 'enter', 'talk', 'listen', 'think', 'celebrate', 'exit'];

/**
 * Standalone overlay page: renders the VRM companion full-bleed. Open it via
 * `chrome-extension://<id>/overlay.html`. It also reacts to `avatar` bridge
 * events emitted by the desktop companion.
 */
export function OverlayApp(): JSX.Element {
  const [mood, setMood] = useState<AvatarMood>('happy');
  const [state, setState] = useState<AvatarState>('enter');
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setState('idle'), 2600);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const listener = (raw: unknown): undefined => {
      if (typeof raw !== 'object' || raw === null) return undefined;
      const event = raw as { type?: unknown; event?: unknown; payload?: unknown };
      if (event.type === 'diggy:bridge-event' && event.event === 'avatar') {
        const payload = event.payload as { mood?: AvatarMood; state?: AvatarState } | undefined;
        if (payload?.mood) setMood(payload.mood);
        if (payload?.state) setState(payload.state);
      }
      return undefined;
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

  return (
    <InkBackground className="h-full" opacity={0.65} density={7} interactive>
      <div className="diggy-root relative flex h-full w-full flex-col items-center justify-between p-4 text-ink">
        <div className="flex items-center gap-2">
          <SketchBadge accent="magenta" size="lg" dot>
            Diggy
          </SketchBadge>
          <SketchBadge accent={ready ? 'green' : 'amber'} size="sm">
            {failed ? 'model unavailable' : ready ? 'online' : 'loading…'}
          </SketchBadge>
        </div>

        <div className="relative h-[62vh] w-[42vh] max-w-full">
          {failed ? (
            <div className="grid h-full w-full place-items-center text-6xl">◕‿◕</div>
          ) : (
            <VrmAvatar
              modelUrl={browser.runtime.getURL(AVATAR_MODEL_PATH)}
              mood={mood}
              state={state}
              talking={state === 'talk'}
              className="h-full w-full"
              onReady={() => setReady(true)}
              onError={() => setFailed(true)}
            />
          )}
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap justify-center gap-1.5">
            {MOODS.map((item) => (
              <SketchButton
                key={item}
                size="sm"
                variant={mood === item ? 'accent' : 'paper'}
                accent="violet"
                onClick={() => {
                  setMood(item);
                }}
              >
                {item}
              </SketchButton>
            ))}
          </div>
          <div className="flex flex-wrap justify-center gap-1.5">
            {STATES.map((item) => (
              <SketchButton
                key={item}
                size="sm"
                variant={state === item ? 'accent' : 'paper'}
                accent="sky"
                onClick={() => {
                  setState(item);
                }}
              >
                {item}
              </SketchButton>
            ))}
          </div>
        </div>
      </div>
    </InkBackground>
  );
}
