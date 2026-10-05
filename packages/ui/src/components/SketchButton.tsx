import { forwardRef, useCallback, useState } from 'react';
import type { ButtonHTMLAttributes, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { ACCENTS } from '../lib/accents';
import type { AccentName } from '../lib/accents';
import { cn } from '../lib/cn';
import { mergeRefs } from '../lib/refs';
import { hashString } from '../lib/rough';
import { useElementSize, useSketchGeometry } from '../lib/useSketch';
import { useId } from 'react';
import { SketchOverlay } from './SketchOverlay';

export type SketchButtonVariant = 'ink' | 'paper' | 'accent' | 'ghost';
export type SketchButtonSize = 'sm' | 'md' | 'lg';

export interface SketchButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: SketchButtonVariant;
  size?: SketchButtonSize;
  accent?: AccentName;
  /** Show a loading indicator and disable interaction. */
  loading?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  seed?: number;
}

const SIZE_CLASSES: Record<SketchButtonSize, string> = {
  sm: 'h-8 gap-1.5 px-3 text-sm',
  md: 'h-10 gap-2 px-4 text-base',
  lg: 'h-12 gap-2.5 px-6 text-lg',
};

/**
 * Hand-drawn button with a spring press, hover wiggle and an ink-blot reveal on
 * pointer-down. Native `<button>` semantics keep keyboard/ARIA behaviour free.
 */
export const SketchButton = forwardRef<HTMLButtonElement, SketchButtonProps>(function SketchButton(
  {
    variant = 'paper',
    size = 'md',
    accent = 'sky',
    loading = false,
    iconLeft,
    iconRight,
    seed,
    className,
    children,
    disabled,
    onPointerDown,
    type,
    ...rest
  },
  ref,
) {
  const uid = useId();
  const resolvedSeed = seed ?? hashString(uid);
  const [sizeRef, measured] = useElementSize<HTMLButtonElement>();
  const geometry = useSketchGeometry('rect', measured, resolvedSeed, { strokeWidth: 1.8 });

  const [blot, setBlot] = useState(0);
  const accentSet = ACCENTS[accent];

  const variantClasses =
    variant === 'ink'
      ? cn('border-ink bg-ink shadow-[3px_3px_0_0_currentColor]', accentSet.text)
      : variant === 'accent'
        ? cn('border-transparent shadow-[3px_3px_0_0_currentColor]', accentSet.bgSoft, accentSet.text)
        : variant === 'ghost'
          ? 'border-transparent bg-transparent text-ink hover:bg-ink/5'
          : 'border-transparent bg-paper shadow-[3px_3px_0_0_currentColor] text-ink';

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      setBlot((count) => count + 1);
      onPointerDown?.(event);
    },
    [onPointerDown],
  );

  const isDisabled = disabled || loading;

  return (
    <button
      {...rest}
      ref={mergeRefs(ref, sizeRef)}
      type={type ?? 'button'}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      data-variant={variant}
      onPointerDown={handlePointerDown}
      className={cn(
        'diggy-root relative inline-flex select-none items-center justify-center overflow-visible rounded-sketch-sm border-2 font-semibold leading-none',
        'transition-transform duration-200 ease-spring will-change-transform',
        'enabled:hover:-translate-y-0.5 enabled:hover:animate-wiggle-once enabled:active:translate-y-0 enabled:active:scale-95',
        'disabled:cursor-not-allowed disabled:opacity-60',
        'motion-reduce:animate-none motion-reduce:transition-none',
        SIZE_CLASSES[size],
        variantClasses,
        className,
      )}
    >
      {blot > 0 ? (
        <span key={blot} className="pointer-events-none absolute inset-0 grid place-items-center overflow-hidden rounded-[inherit]">
          <span aria-hidden="true" className={cn('h-[140%] w-[140%] rounded-full opacity-70 animate-inkblot motion-reduce:animate-none', accentSet.bg)} />
        </span>
      ) : null}

      <SketchOverlay geometry={geometry} className={variant === 'ink' ? 'text-current' : 'text-ink'} />

      <span className="relative z-10 inline-flex items-center justify-center gap-[inherit]">
        {loading ? (
          <span
            aria-hidden="true"
            className={cn('h-3.5 w-3.5 shrink-0 animate-squiggle rounded-[40%] border-2 border-current border-t-transparent motion-reduce:animate-none')}
          />
        ) : (
          iconLeft
        )}
        {children}
        {iconRight}
      </span>
    </button>
  );
});

SketchButton.displayName = 'SketchButton';
