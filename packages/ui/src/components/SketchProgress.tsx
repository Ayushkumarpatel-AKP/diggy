import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { ACCENTS } from '../lib/accents';
import type { AccentName } from '../lib/accents';
import { cn } from '../lib/cn';

export interface SketchProgressProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Current value (ignored when `indeterminate`). */
  value?: number;
  min?: number;
  max?: number;
  indeterminate?: boolean;
  label?: ReactNode;
  showValue?: boolean;
  accent?: AccentName;
  /** Accessible name when no visible `label` is given. */
  'aria-label'?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Hand-drawn progress bar. Exposes a proper `progressbar` role with min/max/now
 * and an `aria-valuetext`, an animated hatched ink fill and an indeterminate
 * shimmer state.
 */
export const SketchProgress = forwardRef<HTMLDivElement, SketchProgressProps>(function SketchProgress(
  {
    value = 0,
    min = 0,
    max = 100,
    indeterminate = false,
    label,
    showValue = false,
    accent = 'cyan',
    className,
    'aria-label': ariaLabel,
    ...rest
  },
  ref,
) {
  const safeMax = max > min ? max : min + 1;
  const current = clamp(value, min, safeMax);
  const percent = ((current - min) / (safeMax - min)) * 100;
  const set = ACCENTS[accent];

  return (
    <div className={cn('diggy-root flex w-full flex-col gap-1.5', className)}>
      {label || showValue ? (
        <div className="flex items-baseline justify-between gap-2 font-sketch text-sm text-ink-700">
          {label ? <span>{label}</span> : <span />}
          {showValue && !indeterminate ? (
            <span className="tabular-nums text-ink-500">
              {Math.round(current)}/{safeMax}
            </span>
          ) : null}
        </div>
      ) : null}

      <div
        {...rest}
        ref={ref}
        role="progressbar"
        aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
        aria-valuemin={min}
        aria-valuemax={safeMax}
        aria-valuenow={indeterminate ? undefined : Math.round(current)}
        aria-valuetext={indeterminate ? 'Loading' : `${Math.round(percent)}%`}
        className="relative h-4 w-full overflow-hidden rounded-sketch-sm border-2 border-ink/80 bg-paper-200"
      >
        <div
          className={cn(
            'absolute inset-y-0 left-0 overflow-hidden transition-[width] duration-700 ease-out motion-reduce:transition-none',
            indeterminate ? cn('w-full animate-shimmer bg-crayon-gradient bg-[length:200%_100%] motion-reduce:animate-none') : set.bg,
          )}
          style={indeterminate ? undefined : { width: `${percent}%` }}
        >
          <span
            aria-hidden="true"
            className="absolute inset-0 opacity-40 [background-image:repeating-linear-gradient(45deg,rgba(27,25,23,0.35)_0_2px,transparent_2px_6px)]"
          />
        </div>
        <span aria-hidden="true" className="diggy-noise pointer-events-none absolute inset-0 opacity-20 mix-blend-multiply" />
      </div>
    </div>
  );
});

SketchProgress.displayName = 'SketchProgress';
