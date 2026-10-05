import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { sketchLine, sketchRect, sketchUnderline } from './rough';
import type { SketchGeometry, SketchStyle } from './rough';

export interface ElementSize {
  width: number;
  height: number;
}

export type SketchKind = 'rect' | 'line' | 'underline';

/** Use the layout effect on the client and a passive effect on the server. */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Track an element's measured size with a `ResizeObserver`.
 *
 * SSR-safe: returns `{ width: 0, height: 0 }` until the element is mounted and
 * measured, which keeps server and first client render identical.
 */
export function useElementSize<T extends HTMLElement>(
  active = true,
): [RefObject<T>, ElementSize] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });

  useIsomorphicLayoutEffect(() => {
    if (!active) return undefined;
    const element = ref.current;
    if (!element) return undefined;

    const measure = () => {
      const rect = element.getBoundingClientRect();
      const width = Math.round(rect.width * 100) / 100;
      const height = Math.round(rect.height * 100) / 100;
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };

    measure();

    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(element);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', measure);
    }

    return () => {
      if (observer) {
        observer.disconnect();
      } else if (typeof window !== 'undefined') {
        window.removeEventListener('resize', measure);
      }
    };
  }, [active]);

  return [ref, size];
}

/**
 * Generate hand-drawn geometry for the given measured size.
 *
 * Returns `null` until a non-zero size is available, so nothing is drawn during
 * SSR or the first paint (avoiding hydration mismatches).
 */
export function useSketchGeometry(
  kind: SketchKind,
  size: ElementSize,
  seed: number,
  style: SketchStyle = {},
): SketchGeometry | null {
  const {
    stroke,
    strokeWidth,
    fill,
    fillStyle,
    roughness,
    bowing,
    curveFitting,
    hachureAngle,
    hachureGap,
    disableMultiStroke,
  } = style;

  return useMemo(() => {
    if (size.width <= 0 || size.height <= 0) return null;
    const params = {
      width: size.width,
      height: size.height,
      seed,
      stroke,
      strokeWidth,
      fill,
      fillStyle,
      roughness,
      bowing,
      curveFitting,
      hachureAngle,
      hachureGap,
      disableMultiStroke,
    };
    if (kind === 'rect') return sketchRect(params);
    if (kind === 'line') return sketchLine(params);
    return sketchUnderline(params);
  }, [
    kind,
    size.width,
    size.height,
    seed,
    stroke,
    strokeWidth,
    fill,
    fillStyle,
    roughness,
    bowing,
    curveFitting,
    hachureAngle,
    hachureGap,
    disableMultiStroke,
  ]);
}
