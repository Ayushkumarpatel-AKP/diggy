/**
 * PostCSS config for the Diggy extension.
 *
 * Tailwind is deliberately optional: the workspace only guarantees the shared
 * `@diggy/ui` pieces, so if `tailwindcss`/`autoprefixer` are not resolvable we
 * fall back to an empty plugin list and the extension still builds (the
 * pen-sketch CSS custom properties from `@diggy/ui/styles.css` remain).
 */
let plugins = {};

try {
  require.resolve('tailwindcss');
  require.resolve('autoprefixer');
  plugins = {
    tailwindcss: {},
    autoprefixer: {},
  };
} catch {
  plugins = {};
}

module.exports = { plugins };
