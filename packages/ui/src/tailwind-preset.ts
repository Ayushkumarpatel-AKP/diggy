import type { Config } from 'tailwindcss';
import { darken, lighten } from './lib/color';

/**
 * Diggy design tokens — "pen-sketch, animated, colorful".
 *
 * Usage (consumer app `tailwind.config.ts`):
 * ```ts
 * import { diggyPreset } from '@diggy/ui';
 * export default { content: [...], presets: [diggyPreset] } satisfies Config;
 * ```
 */

/* ------------------------------------------------------------------ *
 * Colour palette
 * ------------------------------------------------------------------ */

const ink = {
  50: '#f6f5f3',
  100: '#e9e7e2',
  200: '#d3cfc6',
  300: '#b4aea1',
  400: '#8f8878',
  500: '#6f695b',
  600: '#565145',
  700: '#403c33',
  800: '#2b2823',
  900: '#1b1917',
  950: '#100f0d',
  DEFAULT: '#1b1917',
} as const;

const paper = {
  50: '#fffdf7',
  100: '#fdf8ec',
  200: '#f6efd9',
  300: '#efe4c4',
  400: '#e3d3a8',
  500: '#d2be86',
  DEFAULT: '#fdf8ec',
  dark: '#efe7d2',
} as const;

/** Base hues for the colourful "crayon" accents. */
const HUES = {
  pink: '#ff5d8f',
  red: '#ff5a4d',
  orange: '#ff8c42',
  amber: '#ffb703',
  gold: '#f9c74f',
  lime: '#a3d977',
  green: '#43aa8b',
  teal: '#2ec4b6',
  cyan: '#4cc9f0',
  sky: '#4895ef',
  blue: '#4361ee',
  indigo: '#5a5cf0',
  violet: '#9b5de5',
  magenta: '#f15bb5',
} as const;

type HueName = keyof typeof HUES;

/**
 * Each accent exposes `DEFAULT` (base), `soft` (pastel wash) and `deep`
 * (readable-on-paper) so components can pick the right contrast.
 */
const crayon = Object.fromEntries(
  (Object.keys(HUES) as HueName[]).map((name) => {
    const base = HUES[name];
    return [
      name,
      {
        DEFAULT: base,
        soft: lighten(base, 0.45),
        deep: darken(base, 0.3),
      },
    ];
  }),
) as Record<HueName, { DEFAULT: string; soft: string; deep: string }>;

/* ------------------------------------------------------------------ *
 * Keyframes / animations
 * ------------------------------------------------------------------ */

const keyframes = {
  wiggle: {
    '0%, 100%': { transform: 'rotate(0deg)' },
    '25%': { transform: 'rotate(-2.5deg)' },
    '75%': { transform: 'rotate(2.5deg)' },
  },
  float: {
    '0%, 100%': { transform: 'translateY(0)' },
    '50%': { transform: 'translateY(-8px)' },
  },
  inkblot: {
    '0%': { transform: 'scale(0.2)', opacity: '0' },
    '45%': { transform: 'scale(1.05)', opacity: '0.55' },
    '100%': { transform: 'scale(1.6)', opacity: '0' },
  },
  spring: {
    '0%': { transform: 'scale(0.9)' },
    '55%': { transform: 'scale(1.06)' },
    '100%': { transform: 'scale(1)' },
  },
  draw: {
    '0%': { clipPath: 'inset(0 100% 0 0)', opacity: '0' },
    '40%': { opacity: '1' },
    '100%': { clipPath: 'inset(0 0 0 0)', opacity: '1' },
  },
  blob: {
    '0%, 100%': { borderRadius: '42% 58% 63% 37% / 41% 44% 56% 59%', transform: 'rotate(0deg)' },
    '50%': { borderRadius: '58% 42% 33% 67% / 63% 37% 63% 37%', transform: 'rotate(6deg)' },
  },
  shimmer: {
    '0%': { backgroundPosition: '-200% 0' },
    '100%': { backgroundPosition: '200% 0' },
  },
  squiggle: {
    '0%, 100%': { transform: 'translateX(0) skewX(0deg)' },
    '50%': { transform: 'translateX(2px) skewX(-6deg)' },
  },
  bob: {
    '0%, 100%': { transform: 'translateY(0) rotate(-1deg)' },
    '50%': { transform: 'translateY(-4px) rotate(1deg)' },
  },
  pop: {
    '0%': { transform: 'scale(0.7)', opacity: '0' },
    '100%': { transform: 'scale(1)', opacity: '1' },
  },
} as const;

const animation = {
  wiggle: 'wiggle 0.6s ease-in-out infinite',
  'wiggle-once': 'wiggle 0.5s ease-in-out 1',
  float: 'float 6s ease-in-out infinite',
  'float-slow': 'float 9s ease-in-out infinite',
  inkblot: 'inkblot 0.7s cubic-bezier(0.22, 1, 0.36, 1) both',
  spring: 'spring 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both',
  draw: 'draw 0.9s cubic-bezier(0.22, 1, 0.36, 1) both',
  blob: 'blob 12s ease-in-out infinite',
  shimmer: 'shimmer 2.4s linear infinite',
  squiggle: 'squiggle 0.8s ease-in-out infinite',
  bob: 'bob 3s ease-in-out infinite',
  pop: 'pop 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both',
} as const;

/* ------------------------------------------------------------------ *
 * Preset
 * ------------------------------------------------------------------ */

const fontFamily = {
  sketch: [
    '"Patrick Hand"',
    '"Comic Neue"',
    '"Segoe Print"',
    '"Bradley Hand"',
    '"Comic Sans MS"',
    'ui-rounded',
    'system-ui',
    'sans-serif',
  ],
  hand: ['"Caveat"', '"Patrick Hand"', '"Segoe Print"', 'cursive'],
  sans: [
    'ui-sans-serif',
    'system-ui',
    '-apple-system',
    '"Segoe UI"',
    'Roboto',
    '"Helvetica Neue"',
    'Arial',
    'sans-serif',
  ],
  mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', '"Liberation Mono"', 'monospace'],
};

const diggyPreset = {
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        ink,
        paper,
        crayon,
      },
      fontFamily,
      borderRadius: {
        sketch: '255px 15px 225px 15px / 15px 225px 15px 255px',
        'sketch-sm': '125px 10px 115px 10px / 10px 115px 10px 125px',
        'sketch-lg': '255px 25px 225px 25px / 25px 225px 25px 255px',
        blob: '42% 58% 63% 37% / 41% 44% 56% 59%',
        'blob-2': '58% 42% 33% 67% / 63% 37% 63% 37%',
      },
      boxShadow: {
        sketch: '3px 3px 0 0 #1b1917',
        'sketch-sm': '2px 2px 0 0 #1b1917',
        'sketch-lg': '6px 6px 0 0 #1b1917',
        'sketch-soft': '4px 4px 0 0 rgba(27, 25, 23, 0.14)',
        'sketch-inset': 'inset 2px 2px 0 0 rgba(27, 25, 23, 0.12)',
        lift: '0 14px 30px -16px rgba(27, 25, 23, 0.5)',
      },
      backgroundImage: {
        'paper-grid':
          'linear-gradient(rgba(27,25,23,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(27,25,23,0.06) 1px, transparent 1px)',
        'paper-dots':
          'radial-gradient(rgba(27,25,23,0.12) 0.8px, transparent 0.8px)',
        'ink-wash':
          'radial-gradient(120% 120% at 10% 0%, rgba(255,93,143,0.22), transparent 60%), radial-gradient(120% 120% at 90% 20%, rgba(76,201,240,0.22), transparent 55%), radial-gradient(140% 140% at 50% 120%, rgba(155,93,229,0.22), transparent 60%)',
        'crayon-gradient':
          'linear-gradient(120deg, #ff5d8f 0%, #ffb703 25%, #43aa8b 50%, #4895ef 75%, #9b5de5 100%)',
      },
      backgroundSize: {
        'paper-grid': '22px 22px',
        'paper-dots': '16px 16px',
        shimmer: '200% 100%',
      },
      transitionTimingFunction: {
        spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        sketch: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
      keyframes,
      animation,
    },
  },
  plugins: [],
} satisfies Omit<Config, 'content'>;

export default diggyPreset;
export { diggyPreset, keyframes as diggyKeyframes, animation as diggyAnimation };
export { ink as diggyInk, paper as diggyPaper, crayon as diggyCrayon };
export type { HueName as DiggyHueName };
