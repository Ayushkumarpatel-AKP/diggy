import { forwardRef, useId } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { ACCENTS } from '../lib/accents';
import type { AccentName } from '../lib/accents';
import { cn } from '../lib/cn';
import { mergeRefs } from '../lib/refs';
import { hashString } from '../lib/rough';
import { useElementSize, useSketchGeometry } from '../lib/useSketch';
import { SketchOverlay } from './SketchOverlay';

export interface SketchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Marks the field invalid (also auto-derived from `error`). */
  invalid?: boolean;
  /** Draw a full hand-drawn box instead of an underline. */
  boxed?: boolean;
  accent?: AccentName;
  containerClassName?: string;
  seed?: number;
}

/**
 * Hand-drawn text field. The rough underline/box is measured against the input
 * and re-draws on focus; label + hint/error are wired up for screen readers.
 */
export const SketchInput = forwardRef<HTMLInputElement, SketchInputProps>(function SketchInput(
  {
    label,
    hint,
    error,
    invalid,
    boxed = false,
    accent = 'teal',
    containerClassName,
    className,
    id,
    seed,
    ...rest
  },
  ref,
) {
  const uid = useId();
  const inputId = id ?? `diggy-input-${uid.replace(/[:]/g, '')}`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  const resolvedSeed = seed ?? hashString(uid);
  const [sizeRef, measured] = useElementSize<HTMLInputElement>();
  const geometry = useSketchGeometry(boxed ? 'rect' : 'underline', measured, resolvedSeed, {
    strokeWidth: boxed ? 1.6 : 2,
  });

  const isInvalid = invalid ?? Boolean(error);

  return (
    <div className={cn('diggy-root flex w-full flex-col gap-1.5', containerClassName)}>
      {label ? (
        <label htmlFor={inputId} className="font-sketch text-sm font-semibold text-ink-700">
          {label}
        </label>
      ) : null}

      <div className="group relative">
        <input
          {...rest}
          id={inputId}
          ref={mergeRefs(ref, sizeRef)}
          aria-invalid={isInvalid || undefined}
          aria-describedby={describedBy}
          className={cn(
            'w-full rounded-sketch-sm border-0 bg-paper-100/60 px-3 py-2 font-sketch text-ink placeholder:text-ink-400',
            'outline-none transition-colors duration-200',
            'group-focus-within:bg-paper-100',
            isInvalid && 'bg-crayon-red-soft/60',
            className,
          )}
        />
        <SketchOverlay
          geometry={geometry}
          draw
          className={cn(
            'transition-colors duration-200',
            isInvalid ? 'text-crayon-red-deep' : cn('text-ink-500', ACCENTS[accent].textFocus),
          )}
        />
      </div>

      {error ? (
        <p id={errorId} role="alert" className="font-sketch text-sm text-crayon-red-deep">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="font-sketch text-xs text-ink-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
});

SketchInput.displayName = 'SketchInput';
