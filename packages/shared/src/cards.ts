/**
 * Rich cards shown inside chat messages.
 *
 * A card is what makes the assistant feel trustworthy: a link preview with its
 * real logo, a YouTube video with its thumbnail and a Play button, or a
 * snapshot of the page with the submit button highlighted — always with action
 * buttons the user can click.
 */
export type CardKind = 'link' | 'video' | 'snapshot' | 'plugin' | 'generic';

export type CardActionKind = 'link' | 'message' | 'command';

export interface CardAction {
  id: string;
  label: string;
  /** `link` opens a URL, `message` sends text to the assistant, `command` runs a named command. */
  kind: CardActionKind;
  /** The URL, message text, or command id. */
  value: string;
  variant?: 'primary' | 'ghost' | 'danger';
}

export interface CardImage {
  /** Remote image URL (may be blocked by a page CSP inside a content script). */
  url?: string;
  /** Data URL fallback, produced by fetching the image in the background. */
  dataUrl?: string;
  alt?: string;
  /** Natural size in px, when known — lets the renderer reserve space. */
  width?: number;
  height?: number;
}

export interface RichCard {
  id: string;
  kind: CardKind;
  title: string;
  subtitle?: string;
  url?: string;
  /** Site logo / favicon for the link preview. */
  faviconUrl?: string;
  image?: CardImage;
  /** Small pill, e.g. "Filled 12 fields" or "3 min ago". */
  badge?: string;
  /** Bulleted key/value lines rendered under the title. */
  details?: { label: string; value: string }[];
  actions?: CardAction[];
}

/** A card attached to a chat message. */
export interface CardMessage {
  card: RichCard;
}
