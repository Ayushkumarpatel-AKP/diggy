import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { ACCENTS } from '../lib/accents';
import type { AccentName } from '../lib/accents';
import { cn } from '../lib/cn';

export type SketchBadgeVariant = 'soft' | 'solid' | 'outline';
export type SketchBadgeSize = 'sm' | 'md' | 'lg';

export interface SketchBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: SketchBadgeVariant;
  size?: SketchBadgeSize;
  accent?: AccentName;
  /** Render a small colourful indicator dot. */
  dot?: boolean;
  children?: ReactNode;
}

const SIZE_CLASSES: Record<SketchBadgeSize, string> = {
  sm: 'h-5 gap-1 px-2 text-[11px]',
  md: 'h-6 gap-1.5 px-2.5 text-xs',
  lg: 'h-8 gap-2 px-3 text-sm',
};

const DOT_SIZES: Record<SketchBadgeSize, string> = {
  sm: 'h-1.5 w-1.5',
  md: 'h-2 w-2',
  lg: 'h-2.5 w-2.5',
};

/**
 * Hand-drawn pill badge. Uses the sketchy border-radius token plus a
 * `currentColor` offset shadow so it inherits the accent hue automatically.
 */
export const SketchBadge = forwardRef<HTMLSpanElement, SketchBadgeProps>(function SketchBadge(
  { variant = 'soft', size = 'md', accent = 'violet', dot = false, className, children, ...rest },
  ref,
) {
  const set = ACCENTS[accent];

  const variantClasses =
    variant === 'solid'
      ? cn(set.bg, 'border-transparent text-ink')
      : variant === 'outline'
        ? cn('bg-transparent', set.border, set.text)
        : cn(set.bgSoft, 'border-transparent', set.text);

  return (
    <span
      {...rest}
      ref={ref}
      data-variant={variant}
      data-accent={accent}
      className={cn(
        'diggy-root inline-flex shrink-0 items-center justify-center rounded-sketch-sm border-2 border-solid font-sketch font-semibold uppercase tracking-wide',
        'animate-pop shadow-[2px_2px_0_0_currentColor] motion-reduce:animate-none',
        'transition-transform duration-200 ease-spring hover:animate-wiggle-once motion-reduce:transition-none',
        SIZE_CLASSES[size],
        variantClasses,
        className,
      )}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className={cn('shrink-0 animate-float rounded-full border border-ink/40 motion-reduce:animate-none', DOT_SIZES[size], set.bg)}
        />
      ) : null}
      {children}
    </span>
  );
});

SketchBadge.displayName = 'SketchBadge';
