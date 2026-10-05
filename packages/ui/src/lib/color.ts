/**
 * Tiny, dependency-free colour helpers shared by the Tailwind preset and the
 * runtime sketch components. All functions are pure and SSR-safe.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Parse a 3/4/6/8 digit hex colour into RGB channels. Returns `null` on garbage. */
export function hexToRgb(hex: string): RGB | null {
  const raw = hex.trim().replace(/^#/, '');
  const expanded =
    raw.length === 3 || raw.length === 4
      ? raw
          .split('')
          .map((char) => char + char)
          .join('')
      : raw;
  if (expanded.length !== 6 && expanded.length !== 8) return null;
  const value = Number.parseInt(expanded.slice(0, 6), 16);
  if (Number.isNaN(value)) return null;
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function channelToHex(value: number): string {
  return clampByte(value).toString(16).padStart(2, '0');
}

/** Serialise RGB channels back to a `#rrggbb` string. */
export function rgbToHex({ r, g, b }: RGB): string {
  return `#${channelToHex(r)}${channelToHex(g)}${channelToHex(b)}`;
}

/**
 * Linearly mix `hex` toward `target` by `amount` (0 = unchanged, 1 = target).
 * Falls back to the original string when either input is unparseable.
 */
export function mixHex(hex: string, target: string, amount: number): string {
  const from = hexToRgb(hex);
  const to = hexToRgb(target);
  if (!from || !to) return hex;
  const t = Math.max(0, Math.min(1, amount));
  return rgbToHex({
    r: from.r + (to.r - from.r) * t,
    g: from.g + (to.g - from.g) * t,
    b: from.b + (to.b - from.b) * t,
  });
}

/** Lighten a colour toward white. */
export function lighten(hex: string, amount: number): string {
  return mixHex(hex, '#ffffff', amount);
}

/** Darken a colour toward black. */
export function darken(hex: string, amount: number): string {
  return mixHex(hex, '#000000', amount);
}

/** Convert a hex colour to an `rgba()` string. Falls back to the input. */
export function withAlpha(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`;
}
