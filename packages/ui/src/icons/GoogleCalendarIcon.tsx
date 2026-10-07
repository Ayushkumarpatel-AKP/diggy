// Brand mark — used per Google Calendar's brand guidelines; no endorsement implied.
import type { IconProps } from './index.js';

/**
 * The Google Calendar sheet: a rounded calendar card whose frame is split into
 * blue (#4285F4), green (#34A853), yellow (#FBBC04) and red (#EA4335) edges
 * (with darker #1967D2 / #188038 corners), a white face and the blue "31" of
 * the official mark.
 *
 * Hand-authored on the 24×24 grid: a 5.6px frame around a centred white card.
 */
export function GoogleCalendarIcon({ size = 20, className, title }: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}

      {/* white card face */}
      <rect x="5.6" y="5.6" width="12.8" height="12.8" rx="0.6" fill="#FFFFFF" />

      {/* frame — blue top + left (L-shape) */}
      <path fill="#4285F4" d="M2 0H18.4V5.6H5.6V18.4H0V2A2 2 0 0 1 2 0Z" />
      {/* frame — dark-blue top-right corner */}
      <path fill="#1967D2" d="M18.4 0H22A2 2 0 0 1 24 2V5.6H18.4V0Z" />
      {/* frame — yellow right edge */}
      <path fill="#FBBC04" d="M18.4 5.6H24V18.4H18.4V5.6Z" />
      {/* frame — red bottom-right corner */}
      <path fill="#EA4335" d="M18.4 18.4H24V22A2 2 0 0 1 22 24H18.4V18.4Z" />
      {/* frame — green bottom edge */}
      <path fill="#34A853" d="M5.6 18.4H18.4V24H5.6V18.4Z" />
      {/* frame — dark-green bottom-left corner */}
      <path fill="#188038" d="M0 18.4H5.6V24H2A2 2 0 0 1 0 22V18.4Z" />

      {/* the date, "31" */}
      <g
        fill="none"
        stroke="#1A73E8"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M8.4 9.9h2.1a1.5 1.5 0 0 1 0 3h-1a1.5 1.5 0 0 1 0 3h2.2" />
        <path d="M13.7 10l2.1-1.6v7.5" />
      </g>
    </svg>
  );
}
