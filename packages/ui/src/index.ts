/**
 * @diggy/ui — pen-sketch design system
 *
 * Hand-drawn, animated, colourful React primitives plus the Tailwind preset.
 *
 * ```tsx
 * import { SketchButton, SketchCard, diggyPreset } from '@diggy/ui';
 * import '@diggy/ui/styles.css';
 * ```
 */

/* --- Tailwind theme ------------------------------------------------- */
export {
  default as diggyPreset,
  diggyPreset as preset,
  diggyAnimation,
  diggyCrayon,
  diggyInk,
  diggyKeyframes,
  diggyPaper,
} from './tailwind-preset';
export type { DiggyHueName } from './tailwind-preset';

/* --- Utilities ------------------------------------------------------ */
export { cn } from './lib/cn';
export type { ClassValue } from './lib/cn';

export { accentClass, ACCENT_NAMES, ACCENTS } from './lib/accents';
export type { AccentClasses, AccentName } from './lib/accents';

export { darken, hexToRgb, lighten, mixHex, rgbToHex, withAlpha } from './lib/color';
export type { RGB } from './lib/color';

export { assignRef, mergeRefs } from './lib/refs';

export {
  fallbackLinePath,
  fallbackRectPath,
  fallbackUnderlinePath,
  hashString,
  isRoughAvailable,
  newSketchSeed,
  sketchLine,
  sketchRect,
  sketchUnderline,
} from './lib/rough';
export type {
  FillStyleName,
  SketchEngine,
  SketchGeometry,
  SketchParams,
  SketchPath,
  SketchStyle,
} from './lib/rough';

export { useElementSize, useSketchGeometry } from './lib/useSketch';
export type { ElementSize, SketchKind } from './lib/useSketch';

/* --- Components ----------------------------------------------------- */
export { SketchOverlay } from './components/SketchOverlay';
export type { SketchOverlayProps } from './components/SketchOverlay';

export { SketchCard } from './components/SketchCard';
export type { SketchCardProps, SketchCardTone } from './components/SketchCard';

export { SketchButton } from './components/SketchButton';
export type { SketchButtonProps, SketchButtonSize, SketchButtonVariant } from './components/SketchButton';

export { SketchInput } from './components/SketchInput';
export type { SketchInputProps } from './components/SketchInput';

export { SketchBadge } from './components/SketchBadge';
export type { SketchBadgeProps, SketchBadgeSize, SketchBadgeVariant } from './components/SketchBadge';

export { SketchToggle } from './components/SketchToggle';
export type { SketchToggleProps, SketchToggleSize } from './components/SketchToggle';

export { SketchProgress } from './components/SketchProgress';
export type { SketchProgressProps } from './components/SketchProgress';

export { ThinkingDots } from './components/ThinkingDots';
export type { ThinkingDotsProps, ThinkingDotsSize } from './components/ThinkingDots';

export { InkBackground } from './components/InkBackground';
export type { InkBackgroundProps } from './components/InkBackground';

/* --- Brand marks ---------------------------------------------------- */
export * from './icons/index.js';
