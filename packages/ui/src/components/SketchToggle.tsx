import { forwardRef, useId } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { ACCENTS } from '../lib/accents';
import type { AccentName } from '../lib/accents';
import { cn } from '../lib/cn';

export type SketchToggleSize = 'sm' | 'md' | 'lg';

export interface SketchToggleProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'value' | 'defaultValue'> {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  label?: ReactNode;
  size?: SketchToggleSize;
  accent?: AccentName;
}

const TRACK_SIZES: Record<SketchToggleSize, string> = {
  sm: 'h-5 w-9',
  md: 'h-7 w-12',
  lg: 'h-9 w-16',
};

const KNOB_SIZES: Record<SketchToggleSize, string> = {
  sm: 'h-3.5 w-3.5',
  md: 'h-5 w-5',
  lg: 'h-7 w-7',
};

const KNOB_SHIFT: Record<SketchToggleSize, string> = {
  sm: 'translate-x-4',
  md: 'translate-x-5',
  lg: 'translate-x-7',
};

/**
 * Accessible hand-drawn switch. Uses a native `<button role="switch">` so
 * Space/Enter and screen-reader semantics come for free, with a spring-animated
 * ink knob and a coloured sketched track.
 */
export const SketchToggle = forwardRef<HTMLButtonElement, SketchToggleProps>(function SketchToggle(
  {
    checked,
    defaultChecked = false,
    onCheckedChange,
    label,
    size = 'md',
    accent = 'lime',
    className,
    disabled,
    onClick,
    id,
    ...rest
  },
  ref,
) {
  const uid = useId();
  const labelId = label ? id ?? `diggy-toggle-${uid.replace(/[:]/g, '')}` : undefined;
  const set = ACCENTS[accent];

  return (
    <span className={cn('diggy-root inline-flex select-none items-center gap-2.5', className)}>
      <button
        {...rest}
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked ?? defaultChecked}
        aria-labelledby={labelId}
        disabled={disabled}
        data-accent={accent}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) onCheckedChange?.(!(checked ?? defaultChecked));
        }}
        className={cn(
          'relative inline-flex shrink-0 items-center rounded-sketch-sm border-2 border-ink/80 p-0.5',
          'transition-colors duration-300 ease-sketch',
          'enabled:hover:animate-wiggle-once disabled:cursor-not-allowed disabled:opacity-50',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dashed',
          'motion-reduce:animate-none motion-reduce:transition-none',
          TRACK_SIZES[size],
          (checked ?? defaultChecked) ? set.bgSoft : 'bg-paper-200',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none block rounded-full border-2 border-ink/80 shadow-[1px_1px_0_0_currentColor]',
            'transition-transform duration-300 ease-spring',
            (checked ?? defaultChecked) ? KNOB_SHIFT[size] : 'translate-x-0',
            set.bg,
          )}
        />
      </button>
      {label ? (
        <span id={labelId} className="cursor-pointer font-sketch text-sm text-ink-700" onClick={() => onCheckedChange?.(!(checked ?? defaultChecked))}>
          {label}
        </span>
      ) : null}
    </span>
  );
});

SketchToggle.displayName = 'SketchToggle';
