// Brand mark — used per Gmail's brand guidelines; no endorsement implied.
import type { IconProps } from './index.js';

/**
 * The Gmail envelope — red body (#EA4335) with dark-red (#C5221F), yellow
 * (#FBBC05), green (#34A853) and blue (#4285F4) folds.
 *
 * The official paths are drawn on an 88×66 grid (viewBox 52 42 88 66); a single
 * `transform` scales and centres that grid inside the 24×24 icon box.
 */
export function GmailIcon({ size = 20, className, title }: IconProps): JSX.Element {
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
      <g transform="translate(-14.1818 -8.4545) scale(0.27273)">
        <path fill="#4285F4" d="M58 108h14V74L52 59v43c0 3.32 2.69 6 6 6" />
        <path fill="#34A853" d="M120 108h14c3.32 0 6-2.69 6-6V59l-20 15" />
        <path fill="#FBBC05" d="M120 48v26l20-15v-8c0-7.42-8.47-11.65-14.4-7.2" />
        <path fill="#EA4335" d="M72 74V48l24 18 24-18v26L96 92" />
        <path fill="#C5221F" d="M52 51v8l20 15V48l-5.6-4.2c-5.94-4.45-14.4-.22-14.4 7.2" />
      </g>
    </svg>
  );
}
