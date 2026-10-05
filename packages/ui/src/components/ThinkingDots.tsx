import { forwardRef } from 'react';
import type { HTMLAttributes } from 'react';
import { ACCENTS } from '../lib/accents';
import type { AccentName } from '../lib/accents';
import { cn } from '../lib/cn';

export type ThinkingDotsSize = 'sm' | 'md' | 'lg';

export interface ThinkingDotsProps extends HTMLAttributes<HTMLSpanElement> {
  /** Screen-reader status text. */
  label?: string;
  count?: number;
  size?: ThinkingDotsSize;
  /** Hues cycled across the dots (colourful by default). */
  accents?: AccentName[];
}

const SIZE_CLASSES: Record<ThinkingDotsSize, string> = {
  sm: 'h-1.5 w-1.5',
  md: 'h-2.5 w-2.5',
  lg: 'h-3.5 w-3.5',
};

const DEFAULT_ACCENTS: AccentName[] = ['pink', 'amber', 'teal', 'violet'];

/**
 * Animated "thinking" indicator — colourful ink dots that bob with a staggered
 * delay. Announces itself politely to assistive tech via `role="status"`.
 */
export const ThinkingDots = forwardRef<HTMLSpanElement, ThinkingDotsProps>(function ThinkingDots(
  { label = 'Thinking…', count = 3, size = 'md', accents = DEFAULT_ACCENTS, className, ...rest },
  ref,
) {
  const safeCount = Math.max(1, Math.floor(count));

  return (
    <span
      {...rest}
      ref={ref}
      role="status"
      aria-live="polite"
      className={cn('diggy-root inline-flex items-center gap-1.5', className)}
    >
      {Array.from({ length: safeCount }, (_, index) => {
        const accent = accents[index % accents.length] ?? 'amber';
        return (
          <span
            key={index}
            aria-hidden="true"
            className={cn(
              'inline-block animate-float rounded-full border border-ink/30 shadow-[1px_1px_0_0_currentColor] motion-reduce:animate-none',
              SIZE_CLASSES[size],
              ACCENTS[accent].bg,
            )}
            style={{ animationDelay: `${index * 0.15}s`, animationDuration: '1.2s' }}
          />
        );
      })}
      <span className="sr-only">{label}</span>
    </span>
  );
});

ThinkingDots.displayName = 'ThinkingDots';
