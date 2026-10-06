/**
 * Small builders that turn raw data into `RichCard`s.
 *
 * Keeping construction here (rather than inline at each call site) means every
 * card gets a stable `id` and the shape matches `@diggy/shared` exactly, so
 * the renderer never has to guess.
 */
import type { CardAction, CardImage, RichCard } from '@diggy/shared';

/** A card image may be supplied as a `CardImage` or a bare URL string. */
export type CardImageInput = CardImage | string;

/** Stable card id. Uses `crypto.randomUUID` with a tiny defensive fallback. */
function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through to the manual id */
  }
  return `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeImage(image: CardImageInput | undefined): CardImage | undefined {
  if (!image) return undefined;
  return typeof image === 'string' ? { url: image } : image;
}

export interface LinkCardInput {
  url: string;
  title: string;
  subtitle?: string;
  faviconUrl?: string;
  image?: CardImageInput;
  badge?: string;
  details?: { label: string; value: string }[];
  actions?: CardAction[];
}

/** A link preview: favicon + optional hero image + actions. */
export function linkCard(input: LinkCardInput): RichCard {
  return {
    id: newId(),
    kind: 'link',
    title: input.title,
    subtitle: input.subtitle,
    url: input.url,
    faviconUrl: input.faviconUrl,
    image: normalizeImage(input.image),
    badge: input.badge,
    details: input.details,
    actions: input.actions,
  };
}

export interface VideoCardInput {
  videoId: string;
  title: string;
  channel?: string;
  url: string;
  thumbnail: string;
  published?: string;
}

/** A YouTube video: thumbnail hero + Play / Open actions. */
export function videoCard(input: VideoCardInput): RichCard {
  return {
    id: newId(),
    kind: 'video',
    title: input.title,
    subtitle: input.channel,
    url: input.url,
    image: { url: input.thumbnail, alt: input.title },
    badge: input.published,
    actions: [
      {
        id: 'play',
        label: '▶ Play',
        kind: 'command',
        value: `play:${input.videoId}`,
        variant: 'primary',
      },
      { id: 'open', label: 'Open on YouTube', kind: 'link', value: input.url },
    ],
  };
}

export interface SnapshotCardInput {
  title: string;
  subtitle?: string;
  imageDataUrl: string;
  url?: string;
  badge?: string;
  actions?: CardAction[];
}

/** A page snapshot (data-URL image) with optional actions. */
export function snapshotCard(input: SnapshotCardInput): RichCard {
  return {
    id: newId(),
    kind: 'snapshot',
    title: input.title,
    subtitle: input.subtitle,
    url: input.url,
    image: { dataUrl: input.imageDataUrl, alt: input.title },
    badge: input.badge,
    actions: input.actions,
  };
}

export interface PluginCardInput {
  id: string;
  name: string;
  icon: string;
  description: string;
  connected: boolean;
}

/**
 * A plugin / integration card. The plugin `id` is carried in the connect /
 * manage action value; the card itself still gets its own random id.
 */
export function pluginCard(input: PluginCardInput): RichCard {
  return {
    id: newId(),
    kind: 'plugin',
    title: input.name,
    subtitle: input.description,
    faviconUrl: input.icon,
    badge: input.connected ? 'Connected' : undefined,
    details: [{ label: 'Status', value: input.connected ? 'Connected' : 'Not connected' }],
    actions: [
      {
        id: 'toggle',
        label: input.connected ? 'Manage' : 'Connect',
        kind: 'command',
        value: `plugin:${input.id}`,
        variant: input.connected ? 'ghost' : 'primary',
      },
    ],
  };
}
