import rough from 'roughjs';

/**
 * SSR-safe hand-drawn geometry helpers built on top of `roughjs`.
 *
 * `roughjs` can render to a `<canvas>`/`<svg>` element (browser only), but its
 * *generator* is pure maths and DOM-free. We only ever use the generator here,
 * so the same seed produces the same path data everywhere. When no DOM is
 * available (Node/SSR/tests) — or when `roughjs` throws for any reason — we fall
 * back to a small deterministic path generator so markup is never missing.
 */

type RoughGenerator = ReturnType<typeof rough.generator>;

/** The options bag accepted by the rough generator's shape builders. */
type RoughOptions = NonNullable<Parameters<RoughGenerator['rectangle']>[4]>;

export type FillStyleName =
  | 'hachure'
  | 'solid'
  | 'zigzag'
  | 'cross-hatch'
  | 'dots'
  | 'dashed'
  | 'zigzag-line';

/** Styling knobs shared by every sketch shape. Mirrors a subset of rough.js options. */
export interface SketchStyle {
  stroke?: string;
  strokeWidth?: number;
  fill?: string;
  fillStyle?: FillStyleName;
  roughness?: number;
  bowing?: number;
  curveFitting?: number;
  hachureAngle?: number;
  hachureGap?: number;
  disableMultiStroke?: boolean;
}

/** Which renderer to use for a shape. `auto` prefers rough.js in a browser. */
export type SketchEngine = 'auto' | 'rough' | 'fallback';

export interface SketchParams extends SketchStyle {
  width: number;
  height: number;
  seed?: number;
  engine?: SketchEngine;
}

/** A single SVG `<path>` produced by a sketch helper. */
export interface SketchPath {
  d: string;
  stroke?: string;
  strokeWidth?: number;
  fill?: string;
}

export interface SketchGeometry {
  paths: SketchPath[];
  width: number;
  height: number;
  viewBox: string;
}

/** Overshoot room so bowing/wobble never clips against the viewBox. */
const PADDING = 4;

/* ------------------------------------------------------------------ *
 * Environment guards + deterministic fallbacks
 * ------------------------------------------------------------------ */

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function getGenerator(): RoughGenerator | null {
  try {
    return rough.generator();
  } catch {
    return null;
  }
}

/** Small, fast, deterministic PRNG (mulberry32). Same seed ⇒ same output. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function num(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0';
}

/** Deterministic hand-drawn rectangle outline (closed, wobbly, quadratic edges). */
export function fallbackRectPath(
  width: number,
  height: number,
  seed = 1,
  roughness = 1.6,
): string {
  const random = mulberry32(seed);
  const jitter = () => (random() - 0.5) * 2 * roughness;

  const tl = { x: PADDING + jitter(), y: PADDING + jitter() };
  const tr = { x: width - PADDING + jitter(), y: PADDING + jitter() };
  const br = { x: width - PADDING + jitter(), y: height - PADDING + jitter() };
  const bl = { x: PADDING + jitter(), y: height - PADDING + jitter() };
  const between = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
    x: (a.x + b.x) / 2 + jitter(),
    y: (a.y + b.y) / 2 + jitter(),
  });

  const m0 = between(tl, tr);
  const m1 = between(tr, br);
  const m2 = between(br, bl);
  const m3 = between(bl, tl);

  return [
    `M ${num(tl.x)} ${num(tl.y)}`,
    `Q ${num(m0.x)} ${num(m0.y)} ${num(tr.x)} ${num(tr.y)}`,
    `Q ${num(m1.x)} ${num(m1.y)} ${num(br.x)} ${num(br.y)}`,
    `Q ${num(m2.x)} ${num(m2.y)} ${num(bl.x)} ${num(bl.y)}`,
    `Q ${num(m3.x)} ${num(m3.y)} ${num(tl.x)} ${num(tl.y)}`,
    'Z',
  ].join(' ');
}

/** Deterministic hand-drawn horizontal line spanning `width`, vertically centred. */
export function fallbackLinePath(
  width: number,
  height: number,
  seed = 1,
  roughness = 1.4,
): string {
  const random = mulberry32(seed);
  const jitter = () => (random() - 0.5) * 2 * roughness;

  const y = height / 2;
  const x1 = PADDING;
  const x2 = Math.max(PADDING, width - PADDING);
  const y1 = y + jitter();
  const y2 = y + jitter();
  const cx1 = x1 + (x2 - x1) / 3;
  const cy1 = y + jitter() * 1.6;
  const cx2 = x1 + ((x2 - x1) * 2) / 3;
  const cy2 = y + jitter() * 1.6;

  return `M ${num(x1)} ${num(y1)} C ${num(cx1)} ${num(cy1)} ${num(cx2)} ${num(cy2)} ${num(x2)} ${num(y2)}`;
}

/** Deterministic rough-notation style underline: a wavy stroke near the baseline. */
export function fallbackUnderlinePath(
  width: number,
  height: number,
  seed = 1,
  roughness = 1.8,
): string {
  const random = mulberry32(seed);
  const jitter = () => (random() - 0.5) * 2 * roughness;

  const x1 = PADDING;
  const x2 = Math.max(PADDING, width - PADDING);
  const baseline = Math.max(PADDING, height - PADDING - 1);
  const step = (x2 - x1) / 3;

  const xa = x1 + step;
  const xb = x1 + step * 2;
  const ya = baseline + jitter();
  const yb = baseline + jitter();

  return [
    `M ${num(x1)} ${num(baseline + jitter())}`,
    `Q ${num(xa)} ${num(baseline - roughness * 1.5 + jitter())} ${num(xa + step / 2)} ${num(ya)}`,
    `Q ${num(xb)} ${num(baseline + roughness * 1.5 + jitter())} ${num(x2)} ${num(yb)}`,
  ].join(' ');
}

/* ------------------------------------------------------------------ *
 * Shape builders
 * ------------------------------------------------------------------ */

function toRoughOptions(style: SketchStyle, seed: number): RoughOptions {
  return {
    seed,
    roughness: style.roughness ?? 1.2,
    bowing: style.bowing ?? 1.1,
    stroke: style.stroke,
    strokeWidth: style.strokeWidth ?? 2,
    fill: style.fill,
    fillStyle: style.fillStyle,
    curveFitting: style.curveFitting,
    hachureAngle: style.hachureAngle,
    hachureGap: style.hachureGap,
    disableMultiStroke: style.disableMultiStroke,
  };
}

function styledPath(d: string, style: SketchStyle): SketchPath {
  const path: SketchPath = { d };
  if (style.stroke !== undefined) path.stroke = style.stroke;
  if (style.strokeWidth !== undefined) path.strokeWidth = style.strokeWidth;
  return path;
}

function shouldUseRough(engine: SketchEngine): boolean {
  if (engine === 'fallback') return false;
  if (engine === 'rough') return true;
  return isBrowser();
}

function buildGeometry(
  params: SketchParams,
  kind: 'rect' | 'line' | 'underline',
): SketchGeometry {
  const width = Math.max(0, params.width);
  const height = Math.max(0, params.height);
  const seed = params.seed ?? 1;
  const engine = params.engine ?? 'auto';

  const style: SketchStyle = {
    stroke: params.stroke,
    strokeWidth: params.strokeWidth ?? 2,
    fill: params.fill,
    fillStyle: params.fillStyle,
    roughness: params.roughness,
    bowing: params.bowing,
    curveFitting: params.curveFitting,
    hachureAngle: params.hachureAngle,
    hachureGap: params.hachureGap,
    disableMultiStroke: params.disableMultiStroke,
  };

  let paths: SketchPath[] = [];

  if (shouldUseRough(engine)) {
    const generator = getGenerator();
    if (generator) {
      try {
        const options = toRoughOptions(params, seed);
        const drawable = roughDrawable(generator, kind, width, height, seed, options);
        paths = generator.toPaths(drawable).map((info) => {
          const path: SketchPath = { d: info.d, strokeWidth: info.strokeWidth };
          if (info.stroke) path.stroke = info.stroke;
          if (info.fill) path.fill = info.fill;
          return path;
        });
      } catch {
        paths = [];
      }
    }
  }

  if (paths.length === 0) {
    paths = fallbackPaths(kind, width, height, seed, style);
  }

  return {
    paths,
    width,
    height,
    viewBox: `${-PADDING} ${-PADDING} ${width + PADDING * 2} ${height + PADDING * 2}`,
  };
}

function roughDrawable(
  generator: RoughGenerator,
  kind: 'rect' | 'line' | 'underline',
  width: number,
  height: number,
  seed: number,
  options: RoughOptions,
): ReturnType<RoughGenerator['rectangle']> {
  if (kind === 'rect') {
    return generator.rectangle(0, 0, width, height, options);
  }
  if (kind === 'line') {
    return generator.line(PADDING, height / 2, Math.max(PADDING, width - PADDING), height / 2, options);
  }
  const random = mulberry32(seed);
  const jitter = () => (random() - 0.5) * 6;
  const baseline = Math.max(PADDING, height - PADDING - 1);
  const points: Array<[number, number]> = [
    [PADDING, baseline + jitter()],
    [width * 0.33, baseline + jitter()],
    [width * 0.66, baseline + jitter()],
    [Math.max(PADDING, width - PADDING), baseline + jitter()],
  ];
  return generator.curve(points, options);
}

function fallbackPaths(
  kind: 'rect' | 'line' | 'underline',
  width: number,
  height: number,
  seed: number,
  style: SketchStyle,
): SketchPath[] {
  if (kind === 'rect') {
    return [styledPath(fallbackRectPath(width, height, seed, style.roughness ?? 1.6), style)];
  }
  if (kind === 'line') {
    return [styledPath(fallbackLinePath(width, height, seed, style.roughness ?? 1.4), style)];
  }
  return [styledPath(fallbackUnderlinePath(width, height, seed, style.roughness ?? 1.8), style)];
}

/** Hand-drawn rectangle path data filling the given box. */
export function sketchRect(params: SketchParams): SketchGeometry {
  return buildGeometry(params, 'rect');
}

/** Hand-drawn horizontal line path data filling the given box. */
export function sketchLine(params: SketchParams): SketchGeometry {
  return buildGeometry(params, 'line');
}

/** Hand-drawn underline (rough-notation style) filling the given box. */
export function sketchUnderline(params: SketchParams): SketchGeometry {
  return buildGeometry(params, 'underline');
}

/** Deterministic number from an arbitrary string (stable per React `useId`). */
export function hashString(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** A fresh random seed for a one-off sketch. Prefers rough.js' own generator. */
export function newSketchSeed(): number {
  try {
    return rough.newSeed();
  } catch {
    return Math.floor(Math.random() * 2 ** 31);
  }
}

/** Whether rough.js is usable in the current environment (browser-only render path). */
export function isRoughAvailable(): boolean {
  return isBrowser() && getGenerator() !== null;
}
