/**
 * Colourful "crayon" accent palette. Every class name is a literal string so
 * Tailwind's JIT can statically discover them (add `packages/ui/**` to your
 * app's `content` array).
 */

export type AccentName =
  | 'pink'
  | 'red'
  | 'orange'
  | 'amber'
  | 'gold'
  | 'lime'
  | 'green'
  | 'teal'
  | 'cyan'
  | 'sky'
  | 'blue'
  | 'indigo'
  | 'violet'
  | 'magenta';

export interface AccentClasses {
  /** Deep accent text colour (also drives `currentColor` shadows). */
  text: string;
  /** Solid accent background. */
  bg: string;
  /** Soft/light accent background. */
  bgSoft: string;
  /** Accent border colour. */
  border: string;
  /** Accent ring colour for focus states. */
  ring: string;
  /** Accent text colour applied while a parent `.group` has focus-within. */
  textFocus: string;
}

export const ACCENTS: Record<AccentName, AccentClasses> = {
  pink: {
    text: 'text-crayon-pink-deep',
    bg: 'bg-crayon-pink',
    bgSoft: 'bg-crayon-pink-soft',
    border: 'border-crayon-pink',
    ring: 'ring-crayon-pink',
    textFocus: 'group-focus-within:text-crayon-pink-deep',
  },
  red: {
    text: 'text-crayon-red-deep',
    bg: 'bg-crayon-red',
    bgSoft: 'bg-crayon-red-soft',
    border: 'border-crayon-red',
    ring: 'ring-crayon-red',
    textFocus: 'group-focus-within:text-crayon-red-deep',
  },
  orange: {
    text: 'text-crayon-orange-deep',
    bg: 'bg-crayon-orange',
    bgSoft: 'bg-crayon-orange-soft',
    border: 'border-crayon-orange',
    ring: 'ring-crayon-orange',
    textFocus: 'group-focus-within:text-crayon-orange-deep',
  },
  amber: {
    text: 'text-crayon-amber-deep',
    bg: 'bg-crayon-amber',
    bgSoft: 'bg-crayon-amber-soft',
    border: 'border-crayon-amber',
    ring: 'ring-crayon-amber',
    textFocus: 'group-focus-within:text-crayon-amber-deep',
  },
  gold: {
    text: 'text-crayon-gold-deep',
    bg: 'bg-crayon-gold',
    bgSoft: 'bg-crayon-gold-soft',
    border: 'border-crayon-gold',
    ring: 'ring-crayon-gold',
    textFocus: 'group-focus-within:text-crayon-gold-deep',
  },
  lime: {
    text: 'text-crayon-lime-deep',
    bg: 'bg-crayon-lime',
    bgSoft: 'bg-crayon-lime-soft',
    border: 'border-crayon-lime',
    ring: 'ring-crayon-lime',
    textFocus: 'group-focus-within:text-crayon-lime-deep',
  },
  green: {
    text: 'text-crayon-green-deep',
    bg: 'bg-crayon-green',
    bgSoft: 'bg-crayon-green-soft',
    border: 'border-crayon-green',
    ring: 'ring-crayon-green',
    textFocus: 'group-focus-within:text-crayon-green-deep',
  },
  teal: {
    text: 'text-crayon-teal-deep',
    bg: 'bg-crayon-teal',
    bgSoft: 'bg-crayon-teal-soft',
    border: 'border-crayon-teal',
    ring: 'ring-crayon-teal',
    textFocus: 'group-focus-within:text-crayon-teal-deep',
  },
  cyan: {
    text: 'text-crayon-cyan-deep',
    bg: 'bg-crayon-cyan',
    bgSoft: 'bg-crayon-cyan-soft',
    border: 'border-crayon-cyan',
    ring: 'ring-crayon-cyan',
    textFocus: 'group-focus-within:text-crayon-cyan-deep',
  },
  sky: {
    text: 'text-crayon-sky-deep',
    bg: 'bg-crayon-sky',
    bgSoft: 'bg-crayon-sky-soft',
    border: 'border-crayon-sky',
    ring: 'ring-crayon-sky',
    textFocus: 'group-focus-within:text-crayon-sky-deep',
  },
  blue: {
    text: 'text-crayon-blue-deep',
    bg: 'bg-crayon-blue',
    bgSoft: 'bg-crayon-blue-soft',
    border: 'border-crayon-blue',
    ring: 'ring-crayon-blue',
    textFocus: 'group-focus-within:text-crayon-blue-deep',
  },
  indigo: {
    text: 'text-crayon-indigo-deep',
    bg: 'bg-crayon-indigo',
    bgSoft: 'bg-crayon-indigo-soft',
    border: 'border-crayon-indigo',
    ring: 'ring-crayon-indigo',
    textFocus: 'group-focus-within:text-crayon-indigo-deep',
  },
  violet: {
    text: 'text-crayon-violet-deep',
    bg: 'bg-crayon-violet',
    bgSoft: 'bg-crayon-violet-soft',
    border: 'border-crayon-violet',
    ring: 'ring-crayon-violet',
    textFocus: 'group-focus-within:text-crayon-violet-deep',
  },
  magenta: {
    text: 'text-crayon-magenta-deep',
    bg: 'bg-crayon-magenta',
    bgSoft: 'bg-crayon-magenta-soft',
    border: 'border-crayon-magenta',
    ring: 'ring-crayon-magenta',
    textFocus: 'group-focus-within:text-crayon-magenta-deep',
  },
};

export const ACCENT_NAMES: AccentName[] = Object.keys(ACCENTS) as AccentName[];

/** Resolve the class string for one slot of an accent. */
export function accentClass(accent: AccentName, slot: keyof AccentClasses): string {
  return ACCENTS[accent][slot];
}
