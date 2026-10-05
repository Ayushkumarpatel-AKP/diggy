import { useEffect, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { cn } from '../lib/cn';
import { withAlpha } from '../lib/color';

export interface InkBackgroundProps {
  className?: string;
  style?: CSSProperties;
  /** Ink blob colours (defaults to a colourful multi-hue wash). */
  colors?: string[];
  /** Number of drifting blobs. */
  density?: number;
  /** Playback speed multiplier. */
  speed?: number;
  /** CSS blur applied to the canvas for a soft ink-wash look. */
  blur?: number;
  /** Canvas opacity. */
  opacity?: number;
  /** Freeze the animation (e.g. when a modal is open). */
  paused?: boolean;
  /** Blobs gently follow the pointer. */
  interactive?: boolean;
  /** Deterministic seed for blob layout. */
  seed?: number;
  /** Overlay paper fibre noise on top of the ink. */
  noise?: boolean;
  /** Optional content rendered above the background. */
  children?: ReactNode;
}

const DEFAULT_COLORS = ['#ff5d8f', '#ffb703', '#43aa8b', '#4895ef', '#9b5de5', '#f15bb5'];

interface Blob {
  x: number;
  y: number;
  r: number;
  ci: number;
  phase: number;
  dx: number;
  dy: number;
  dr: number;
  pull: number;
}

/** Tiny deterministic PRNG so blob layout is stable for a given seed. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Animated, colourful ink/gradient canvas backdrop.
 *
 * SSR-safe (drawing only happens in an effect), and it pauses itself when the
 * tab is hidden, when scrolled out of view, or when `prefers-reduced-motion` is
 * set — so it never burns CPU in the background.
 */
export function InkBackground({
  className,
  style,
  colors = DEFAULT_COLORS,
  density = 6,
  speed = 1,
  blur = 20,
  opacity = 0.85,
  paused = false,
  interactive = false,
  seed = 7,
  noise = true,
  children,
}: InkBackgroundProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerRef = useRef({ x: 0.5, y: 0.5, active: false });
  const colorKey = colors.join('|');

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return undefined;
    const context = canvas.getContext('2d');
    if (!context) return undefined;

    const palette = colorKey.length > 0 ? colorKey.split('|') : DEFAULT_COLORS;
    const prefersReduced =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const random = createRandom(seed);
    const count = Math.max(1, Math.min(16, Math.floor(density)));
    const blobs: Blob[] = Array.from({ length: count }, () => ({
      x: 0.15 + random() * 0.7,
      y: 0.15 + random() * 0.7,
      r: 0.28 + random() * 0.35,
      ci: Math.floor(random() * palette.length),
      phase: random() * Math.PI * 2,
      dx: 0.2 + random() * 0.5,
      dy: 0.2 + random() * 0.5,
      dr: 0.15 + random() * 0.3,
      pull: 0.02 + random() * 0.05,
    }));

    const size = { width: 1, height: 1 };
    let rafId = 0;
    let startTime = 0;
    let visible = true;

    const draw = (time: number) => {
      const { width, height } = size;
      context.clearRect(0, 0, width, height);
      context.globalCompositeOperation = 'lighter';

      for (const blob of blobs) {
        let px = blob.x * width + Math.sin(time * blob.dx + blob.phase) * width * 0.14;
        let py = blob.y * height + Math.cos(time * blob.dy + blob.phase * 1.3) * height * 0.16;

        if (interactive && pointerRef.current.active) {
          px += (pointerRef.current.x * width - px) * blob.pull;
          py += (pointerRef.current.y * height - py) * blob.pull;
        }

        const radius = Math.max(
          1,
          blob.r * Math.max(width, height) * (0.85 + 0.15 * Math.sin(time * blob.dr + blob.phase)),
        );
        const color = palette[blob.ci] ?? palette[0] ?? '#ff5d8f';
        const gradient = context.createRadialGradient(px, py, 0, px, py, radius);
        gradient.addColorStop(0, withAlpha(color, 0.55));
        gradient.addColorStop(0.45, withAlpha(color, 0.22));
        gradient.addColorStop(1, withAlpha(color, 0));
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(px, py, radius, 0, Math.PI * 2);
        context.fill();
      }

      context.globalCompositeOperation = 'source-over';
    };

    const tick = (now: number) => {
      if (!startTime) startTime = now;
      draw(((now - startTime) / 1000) * speed);
      rafId = window.requestAnimationFrame(tick);
    };

    const startLoop = () => {
      if (prefersReduced || paused || rafId !== 0 || !visible) return;
      startTime = 0;
      rafId = window.requestAnimationFrame(tick);
    };

    const stopLoop = () => {
      if (rafId !== 0) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
    };

    const resize = () => {
      const rect = host.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      size.width = Math.max(1, rect.width);
      size.height = Math.max(1, rect.height);
      canvas.width = Math.floor(size.width * dpr);
      canvas.height = Math.floor(size.height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(0);
    };

    const onVisibility = () => {
      if (document.hidden) stopLoop();
      else startLoop();
    };

    const onPointerMove = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      pointerRef.current = {
        x: (event.clientX - rect.left) / Math.max(1, rect.width),
        y: (event.clientY - rect.top) / Math.max(1, rect.height),
        active: true,
      };
    };

    const onPointerLeave = () => {
      pointerRef.current.active = false;
    };

    resize();

    let resizeObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(host);
    } else {
      window.addEventListener('resize', resize);
    }

    let intersectionObserver: IntersectionObserver | undefined;
    if (typeof IntersectionObserver !== 'undefined') {
      intersectionObserver = new IntersectionObserver((entries) => {
        const entry = entries[0];
        visible = entry ? entry.isIntersecting : true;
        if (visible) startLoop();
        else stopLoop();
      });
      intersectionObserver.observe(host);
    }

    document.addEventListener('visibilitychange', onVisibility);
    if (interactive) {
      host.addEventListener('pointermove', onPointerMove);
      host.addEventListener('pointerleave', onPointerLeave);
    }

    if (!prefersReduced && !paused) startLoop();
    else draw(0);

    return () => {
      stopLoop();
      resizeObserver?.disconnect();
      if (!resizeObserver) window.removeEventListener('resize', resize);
      intersectionObserver?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerleave', onPointerLeave);
    };
  }, [paused, speed, density, interactive, seed, colorKey]);

  return (
    <div
      ref={hostRef}
      className={cn('diggy-root relative isolate block h-full w-full overflow-hidden bg-paper', className)}
      style={style}
      aria-hidden={children ? undefined : true}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        style={{ opacity, filter: blur > 0 ? `blur(${blur}px)` : undefined }}
      />
      {noise ? (
        <span
          aria-hidden="true"
          className="diggy-noise pointer-events-none absolute inset-0 opacity-[0.14] mix-blend-multiply"
        />
      ) : null}
      {children ? <div className="relative z-10 h-full w-full">{children}</div> : null}
    </div>
  );
}
