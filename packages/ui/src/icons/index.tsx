/**
 * Brand marks for the Diggy plugins gallery.
 *
 * Every provider is drawn locally as an inline-SVG React component — nothing is
 * fetched at runtime, so the marks work offline and satisfy the extension's
 * content-security policy. Colours follow each brand's guidelines.
 *
 * ```tsx
 * import { providerIcon } from '@diggy/ui';
 *
 * const Mark = providerIcon('notion');
 * return Mark ? <Mark size={18} title="Notion" /> : <FallbackGlyph />;
 * ```
 */
import { GmailIcon } from './GmailIcon.js';
import { GitHubIcon } from './GitHubIcon.js';
import { GoogleCalendarIcon } from './GoogleCalendarIcon.js';
import { GoogleIcon } from './GoogleIcon.js';
import { NotionIcon } from './NotionIcon.js';
import { YouTubeIcon } from './YouTubeIcon.js';

/** Props shared by every provider mark. */
export interface IconProps {
  /** Rendered width/height in pixels. */
  size?: number;
  /** Extra classes forwarded to the root `<svg>`. */
  className?: string;
  /** Accessible name; when omitted the mark is hidden from assistive tech. */
  title?: string;
}

// Brand marks — each used per its owner's brand guidelines; no endorsement implied.
export { GmailIcon } from './GmailIcon.js';
export { GitHubIcon } from './GitHubIcon.js';
export { GoogleCalendarIcon } from './GoogleCalendarIcon.js';
export { GoogleIcon } from './GoogleIcon.js';
export { NotionIcon } from './NotionIcon.js';
export { YouTubeIcon } from './YouTubeIcon.js';

export type ProviderIconId = 'google' | 'gmail' | 'googleCalendar' | 'notion' | 'github' | 'youtube';

/** Resolve a provider id to its mark; returns undefined for unknown ids. */
export function providerIcon(id: string): ((props: IconProps) => JSX.Element) | undefined {
  switch (id) {
    case 'google':
      return GoogleIcon;
    case 'gmail':
      return GmailIcon;
    case 'googleCalendar':
    case 'calendar':
      return GoogleCalendarIcon;
    case 'notion':
      return NotionIcon;
    case 'github':
      return GitHubIcon;
    case 'youtube':
      return YouTubeIcon;
    default:
      return undefined;
  }
}
