import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { ReactElement } from 'react';
import type { AvatarMood, AvatarState } from '@diggy/shared';

import { AvatarEngine } from './avatar-engine.js';
import type { AvatarEngineOptions } from './avatar-engine.js';

export interface VrmAvatarProps {
  /** URL of the `.vrm` model to load. */
  modelUrl: string;
  /** High level behaviour driven by the state machine. */
  state?: AvatarState;
  /** Facial mood (blended smoothly). */
  mood?: AvatarMood;
  /** Enable the `talk` behaviour (arm gestures + lip-sync mouth if audio is attached). */
  talking?: boolean;
  /** Which side the avatar walks in from / out to. */
  side?: 'left' | 'right';
  /** Fraction of the viewport height the body occupies (0..1). */
  fitFraction?: number;
  /** Normalised (0..1) screen position of the body centre. */
  anchor?: { x: number; y: number };
  /** Extra CSS classes applied to the `<canvas>`. */
  className?: string;
  /** Called once the model has finished loading. */
  onReady?: () => void;
  /** Called if loading or setup fails. */
  onError?: (error: unknown) => void;
  /** Engine tuning options (framing, FPS cap, pixel ratio, ...). */
  engineOptions?: AvatarEngineOptions;
}

/** Imperative controls exposed to the host (walk in/out, side, ...). */
export interface VrmAvatarHandle {
  walkIn(side?: 'left' | 'right'): void;
  walkOut(side?: 'left' | 'right'): void;
  setSide(side: 'left' | 'right'): void;
  engine(): AvatarEngine | null;
}

/**
 * A plain three.js VRM avatar rendered into a `<canvas>`.
 *
 * Deliberately **not** built on react-three-fiber — it owns a single
 * {@link AvatarEngine} instance, created in an effect and disposed on cleanup.
 */
export const VrmAvatar = forwardRef<VrmAvatarHandle, VrmAvatarProps>(function VrmAvatar(
  props,
  ref,
): ReactElement {
  const { modelUrl, state, mood, talking, side, fitFraction, anchor, className, onReady, onError, engineOptions } =
    props;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<AvatarEngine | null>(null);

  // Keep the latest callbacks without re-creating the engine.
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onReadyRef.current = onReady;
    onErrorRef.current = onError;
  });

  // Create the engine, mount it and load the model.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const engine = new AvatarEngine(engineOptions);
    engineRef.current = engine;
    engine.mount(canvas);

    let cancelled = false;
    engine
      .load(modelUrl)
      .then(() => {
        if (cancelled) return;
        onReadyRef.current?.();
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        onErrorRef.current?.(error);
      });

    return () => {
      cancelled = true;
      engineRef.current = null;
      engine.dispose();
    };
  }, [modelUrl, engineOptions]);

  useImperativeHandle(
    ref,
    () => ({
      walkIn: (to) => engineRef.current?.walkIn(to),
      walkOut: (to) => engineRef.current?.walkOut(to),
      setSide: (to) => engineRef.current?.setSide(to),
      engine: () => engineRef.current,
    }),
    [],
  );

  // Push prop changes into the running engine.
  useEffect(() => {
    engineRef.current?.setState(state ?? 'idle');
  }, [state, modelUrl]);

  useEffect(() => {
    if (mood) engineRef.current?.setExpression(mood);
  }, [mood, modelUrl]);

  useEffect(() => {
    engineRef.current?.setTalking(Boolean(talking));
  }, [talking, modelUrl]);

  useEffect(() => {
    if (side) engineRef.current?.setSide(side);
  }, [side, modelUrl]);

  useEffect(() => {
    engineRef.current?.setFraming({ fitFraction, anchor });
    // Depend on the primitives so a fresh `anchor` object literal is harmless.
  }, [fitFraction, anchor?.x, anchor?.y, modelUrl]);

  return <canvas ref={canvasRef} className={className} data-diggy-avatar="" />;
});
