import type { CSSProperties } from 'react';
import { cn } from '../lib/cn';
import type { SketchGeometry } from '../lib/rough';

export interface SketchOverlayProps {
  /** Geometry from `sketchRect` / `sketchLine` / `sketchUnderline` (or `null`). */
  geometry: SketchGeometry | null;
  className?: string;
  style?: CSSProperties;
  /** Multiply every path's stroke width. */
  strokeScale?: number;
  /** When true the ink appears left-to-right (`animate-draw`). */
  draw?: boolean;
}

/**
 * Absolutely-positioned SVG overlay that paints hand-drawn rough paths on top of
 * (or behind) a component. Purely decorative, so it is hidden from assistive
 * tech. Renders nothing until geometry is available (SSR-safe).
 */
export function SketchOverlay({
  geometry,
  className,
  style,
  strokeScale = 1,
  draw = false,
}: SketchOverlayProps) {
  if (!geometry || geometry.paths.length === 0) return null;

  return (
    <svg
      className={cn(
        'pointer-events-none absolute inset-0 h-full w-full overflow-visible',
        draw && 'diggy-draw-in',
        className,
      )}
      viewBox={geometry.viewBox}
      width={geometry.width}
      height={geometry.height}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      style={style}
    >
      {geometry.paths.map((path, index) => (
        <path
          key={`${index}-${path.d.length}`}
          d={path.d}
          fill={path.fill ?? 'none'}
          stroke={path.stroke ?? 'currentColor'}
          strokeWidth={(path.strokeWidth ?? 1.6) * strokeScale}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}
