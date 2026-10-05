import { forwardRef, useId } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { ACCENTS } from '../lib/accents';
import type { AccentName } from '../lib/accents';
import { cn } from '../lib/cn';
import { mergeRefs } from '../lib/refs';
import { hashString } from '../lib/rough';
import { useElementSize, useSketchGeometry } from '../lib/useSketch';
import { SketchOverlay } from './SketchOverlay';

export type SketchCardTone = 'paper' | 'ink' | 'accent' | 'muted';

export interface SketchCardProps extends HTMLAttributes<HTMLDivElement> {
  tone?: SketchCardTone;
  /** Accent hue used when `tone="accent"` and for the hand-drawn border. */
  accent?: AccentName;
  /** Adds hover lift + wiggle micro-animations. */
  interactive?: boolean;
  /** Apply the default padding. */
  padded?: boolean;
  /** Draw the hand-drawn paper texture overlay. */
  textured?: boolean;
  /** Deterministic rough seed (defaults to a stable per-instance hash). */
  seed?: number;
  children?: ReactNode;
}

const TONE_CLASSES: Record<SketchCardTone, string> = {
  paper: 'bg-paper text-ink',
  ink: 'bg-ink text-paper',
  accent: 'text-ink',
  muted: 'bg-paper-200 text-ink-700',
};

/**
 * Hand-drawn surface. Renders a rough.js rectangle outline that re-measures with
 * the element, plus optional paper texture and hover micro-animations.
 */
export const SketchCard = forwardRef<HTMLDivElement, SketchCardProps>(function SketchCard(
  {
    tone = 'paper',
    accent = 'amber',
    interactive = false,
    padded = true,
    textured = false,
    seed,
    className,
    children,
    ...rest
  },
  ref,
) {
  const uid = useId();
  const resolvedSeed = seed ?? hashString(uid);
  const [sizeRef, size] = useElementSize<HTMLDivElement>();
  const geometry = useSketchGeometry('rect', size, resolvedSeed, { strokeWidth: 1.6 });

  const toneClass = tone === 'accent' ? `${ACCENTS[accent].bgSoft} text-ink` : TONE_CLASSES[tone];

  return (
    <div
      {...rest}
      ref={mergeRefs(ref, sizeRef)}
      data-tone={tone}
      data-accent={accent}
      className={cn(
        'diggy-root relative rounded-sketch border-2 border-ink/80 shadow-sketch-soft transition-transform duration-300 ease-spring',
        toneClass,
        padded && 'p-5',
        interactive && 'hover:-translate-y-0.5 hover:shadow-lift hover:animate-wiggle-once focus-within:-translate-y-0.5',
        'motion-reduce:animate-none motion-reduce:transition-none',
        className,
      )}
    >
      {textured ? (
        <span
          aria-hidden="true"
          className="diggy-noise pointer-events-none absolute inset-0 rounded-[inherit] opacity-[0.18] mix-blend-multiply"
        />
      ) : null}
      <SketchOverlay geometry={geometry} className={cn('text-ink', tone === 'accent' && ACCENTS[accent].text)} />
      <div className="relative z-10">{children}</div>
    </div>
  );
});

SketchCard.displayName = 'SketchCard';
