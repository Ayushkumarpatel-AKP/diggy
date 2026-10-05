import { diggyPreset } from '@diggy/ui/tailwind-preset';

/**
 * Tailwind config for the Diggy extension.
 *
 * Uses the `@diggy/ui` pen-sketch preset and scans both the local entrypoints /
 * src and the shared UI package so every utility class the components use is
 * generated. (Tailwind is an optional dependency in this workspace — see
 * `postcss.config.cjs`.)
 */
export default {
  content: [
    './entrypoints/**/*.{html,ts,tsx}',
    './src/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  presets: [diggyPreset],
};
