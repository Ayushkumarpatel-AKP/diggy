import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge conditional class names and de-duplicate conflicting Tailwind utilities.
 *
 * Mirrors the ergonomics of the classic `shadcn`/`cn` helper so consumers can
 * forward `className` props safely.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export type { ClassValue };
