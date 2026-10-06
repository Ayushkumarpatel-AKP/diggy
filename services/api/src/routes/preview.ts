/**
 * Preview helpers: favicons, OpenGraph link previews and YouTube channel feeds.
 *
 * Everything here is regex-based (no HTML parser dependency) and — except for
 * the YouTube helpers — pure, so the parsing can be unit-tested with a fixture
 * string and no network.
 */
import type { FastifyInstance } from 'fastify';

// A real browser UA: YouTube serves a reduced page (no video lockups) to bot
// user agents, which breaks the channel-page fallback.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const YOUTUBE_CHANNEL_ID = /UC[0-9A-Za-z_-]{22}/;

export interface MetaResult {
  title?: string;
  description?: string;
  image?: string;
  faviconUrl?: string;
}

export interface YouTubeVideo {
  channelId: string;
  videoId: string;
  title: string;
  url: string;
  thumbnail: string;
  published: string;
}

/** The Google favicon service URL for a page, derived from its hostname. */
export function faviconUrlFor(pageUrl: string): string | undefined {
  try {
    const { hostname } = new URL(pageUrl);
    if (!hostname) return undefined;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=64`;
  } catch {
    return undefined;
  }
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s/>]+))`, 'i').exec(tag);
  if (!match) return undefined;
  return match[1] ?? match[2] ?? match[3] ?? undefined;
}

function metaMap(html: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = attribute(tag, 'property') ?? attribute(tag, 'name');
    const content = attribute(tag, 'content');
    if (key && content !== undefined) map.set(key.toLowerCase(), content);
  }
  return map;
}

function firstIconHref(html: string): string | undefined {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (attribute(tag, 'rel') ?? '').toLowerCase();
    if (rel.split(/\s+/).includes('icon')) {
      const href = attribute(tag, 'href');
      if (href) return href;
    }
  }
  return undefined;
}

function absolute(href: string | undefined, base: string | undefined): string | undefined {
  if (!href) return undefined;
  if (!base) return href;
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/** Parse `<title>`, OpenGraph and icon tags out of an HTML document. */
export function parseMeta(html: string, pageUrl?: string): MetaResult {
  const tags = metaMap(html);
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  const icon = absolute(firstIconHref(html), pageUrl) ?? (pageUrl ? faviconUrlFor(pageUrl) : undefined);

  return {
    title: tags.get('og:title') ?? (titleTag || undefined),
    description: tags.get('og:description') ?? tags.get('description') ?? undefined,
    image: absolute(tags.get('og:image'), pageUrl),
    faviconUrl: icon,
  };
}

/**
 * Extract the newest video from a YouTube channel Atom feed. Returns
 * `undefined` when the feed has no entries. Pure — used by `/preview` and the
 * `youtube.latest` action, and unit-tested against a fixture.
 */
export function parseYouTubeFeed(xml: string): YouTubeVideo | undefined {
  const channelId =
    /<yt:channelId>\s*([^<\s]+)\s*<\/yt:channelId>/i.exec(xml)?.[1] ??
    (/<id>\s*yt:channel:([^<\s]+)\s*<\/id>/i.exec(xml)?.[1]) ??
    '';

  const entry = /<entry>([\s\S]*?)<\/entry>/i.exec(xml)?.[1];
  if (!entry) return undefined;

  const videoId = /<yt:videoId>\s*([^<\s]+)\s*<\/yt:videoId>/i.exec(entry)?.[1];
  if (!videoId) return undefined;

  const title = /<title>\s*([\s\S]*?)\s*<\/title>/i.exec(entry)?.[1]?.trim() ?? '';
  const published = /<published>\s*([^<\s]+)\s*<\/published>/i.exec(entry)?.[1] ?? '';
  const thumbnail =
    /<media:thumbnail\b[^>]*\burl="([^"]+)"/i.exec(entry)?.[1] ??
    `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  const url =
    /<link\b[^>]*\brel="alternate"[^>]*\bhref="([^"]+)"/i.exec(entry)?.[1] ??
    `https://www.youtube.com/watch?v=${videoId}`;

  return { channelId, videoId, title, url, thumbnail, published };
}

export interface ResolvedChannel {
  channelId?: string;
  /** Page that must be fetched to discover the id, when it is not known yet. */
  pageUrl?: string;
}

/** Accept a raw channel id, a `@handle`, a bare handle, or any channel URL. */
export function normalizeChannelInput(input: string): ResolvedChannel {
  const value = input.trim();
  if (YOUTUBE_CHANNEL_ID.test(value) && value.length <= 24) return { channelId: value };

  if (/^https?:\/\//i.test(value)) {
    const fromQuery = /[?&]channel_id=(UC[0-9A-Za-z_-]{22})/.exec(value)?.[1];
    const fromPath = /\/channel\/(UC[0-9A-Za-z_-]{22})/.exec(value)?.[1];
    if (fromQuery ?? fromPath) return { channelId: (fromQuery ?? fromPath) as string };
    return { pageUrl: value };
  }

  const handle = value.replace(/^@/, '');
  return { pageUrl: `https://www.youtube.com/@${handle}` };
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  if (!response.ok) throw new Error(`Request to ${url} failed with ${response.status}`);
  return response.text();
}

/** Resolve any channel reference to its `UC…` id (may require one fetch). */
export async function resolveChannelId(input: string): Promise<string | undefined> {
  const normalized = normalizeChannelInput(input);
  if (normalized.channelId) return normalized.channelId;
  if (!normalized.pageUrl) return undefined;

  const html = await fetchText(normalized.pageUrl);
  // Order matters: the page's OWN metadata first. The embedded JSON routinely
  // mentions *recommended* channels before the page's own id.
  const fromMeta = /<meta\s+itemprop="channelId"\s+content="(UC[0-9A-Za-z_-]{22})"/i.exec(html)?.[1];
  const fromLink = /<link\s+rel="canonical"\s+href="https:\/\/www\.youtube\.com\/channel\/(UC[0-9A-Za-z_-]{22})"/i.exec(html)?.[1];
  const fromJson = /"externalId":"(UC[0-9A-Za-z_-]{22})"/.exec(html)?.[1];
  return fromMeta ?? fromLink ?? fromJson ?? /"channelId":"(UC[0-9A-Za-z_-]{22})"/.exec(html)?.[1];
}

/**
 * Pure: the newest video from a channel `/videos` page.
 *
 * Fallback only — YouTube frequently answers the public RSS feed with a 404,
 * while the channel page itself still renders.
 */
export function parseChannelVideosPage(html: string, channelId: string): YouTubeVideo | undefined {
  const source = html ?? '';
  const pattern = /"lockupMetadataViewModel":\{"title":\{"content":"((?:[^"\\]|\\.)*)"/g;
  const titles: { index: number; title: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const raw = match[1];
    if (!raw) continue;
    titles.push({ index: match.index, title: decodeJsonText(raw) });
  }

  for (let i = 0; i < titles.length; i += 1) {
    const entry = titles[i];
    if (!entry?.title) continue;
    // A video's `contentId` sits well *after* its title (the metadata block comes
    // first), so search up to the next lockup rather than a fixed window.
    const end = titles[i + 1]?.index ?? Math.min(source.length, entry.index + 20_000);
    const videoId = /"contentId":"([A-Za-z0-9_-]{11})"/.exec(source.slice(entry.index, end))?.[1];
    if (!videoId) continue;
    return {
      channelId,
      videoId,
      title: entry.title,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      published: '',
    };
  }
  return undefined;
}

/** Undo JSON + HTML escaping inside a scraped `"content":"…"` value. */
function decodeJsonText(value: string): string {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_all, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Resolve a channel reference to its newest video. */
export async function latestForChannel(channel: string): Promise<YouTubeVideo | undefined> {
  const channelId = await resolveChannelId(channel);
  if (!channelId) return undefined;

  try {
    const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
    const video = parseYouTubeFeed(xml);
    if (video) return { ...video, channelId };
  } catch {
    /* the feed is often blocked — fall through to the page scrape */
  }

  const html = await fetchText(`https://www.youtube.com/channel/${channelId}/videos`);
  return parseChannelVideosPage(html, channelId);
}

interface UrlQuery {
  url?: string;
  html?: string;
}

interface ChannelQuery {
  channel?: string;
}

export function registerPreviewRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: UrlQuery }>('/favicon', async (request, reply) => {
    const url = typeof request.query.url === 'string' ? request.query.url.trim() : '';
    if (!url) {
      reply.code(400);
      return { error: 'invalid_request', message: 'Query parameter "url" is required.' };
    }
    const faviconUrl = faviconUrlFor(url);
    if (!faviconUrl) {
      reply.code(400);
      return { error: 'invalid_url', message: `Could not derive a domain from "${url}".` };
    }
    return { faviconUrl };
  });

  app.get<{ Querystring: UrlQuery }>('/meta', async (request, reply) => {
    const url = typeof request.query.url === 'string' ? request.query.url.trim() : '';
    const inlineHtml = typeof request.query.html === 'string' ? request.query.html : undefined;

    if (inlineHtml !== undefined) {
      return parseMeta(inlineHtml, url || undefined);
    }
    if (!url) {
      reply.code(400);
      return { error: 'invalid_request', message: 'Query parameter "url" is required.' };
    }
    try {
      const html = await fetchText(url);
      return parseMeta(html, url);
    } catch (error) {
      reply.code(502);
      return { error: 'fetch_failed', message: error instanceof Error ? error.message : String(error) };
    }
  });

  app.get<{ Querystring: ChannelQuery }>('/youtube/latest', async (request, reply) => {
    const channel = typeof request.query.channel === 'string' ? request.query.channel.trim() : '';
    if (!channel) {
      reply.code(400);
      return { error: 'invalid_request', message: 'Query parameter "channel" is required.' };
    }
    try {
      const video = await latestForChannel(channel);
      if (!video) {
        reply.code(404);
        return { error: 'not_found', message: `No latest video found for "${channel}".` };
      }
      return video;
    } catch (error) {
      reply.code(502);
      return { error: 'fetch_failed', message: error instanceof Error ? error.message : String(error) };
    }
  });
}
