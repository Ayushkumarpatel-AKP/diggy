/**
 * YouTube helpers for video cards.
 *
 * `parseYouTubeFeed` is a PURE Atom parser (regex, no DOM) so it can be
 * unit-tested directly. `resolveChannelId` turns a channel id, `@handle`,
 * channel URL or bare name into a `UC…` id by reading the channel page.
 * `latestVideos` combines both: resolve the channel, then read its feed.
 *
 * The network helpers never throw — they return `undefined` / `[]`.
 */

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** A 24-char `UC…` channel id: "UC" plus 22 id characters. */
const CHANNEL_ID = 'UC[A-Za-z0-9_-]{20,}';

export interface YouTubeVideo {
  videoId: string;
  title: string;
  url: string;
  thumbnail: string;
  published: string;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function tagText(block: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return match ? decodeEntities(match[1]) : '';
}

function linkHref(block: string, rel?: string): string {
  const links = block.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of links) {
    const href = /\bhref="([^"]+)"/i.exec(tag)?.[1];
    if (!href) continue;
    if (!rel) return href;
    if (new RegExp(`\\brel="${rel}"`, 'i').test(tag)) return href;
  }
  return '';
}

/**
 * Parse a YouTube Atom feed (or the videos.xml subset) into videos.
 * Pure — identical input yields identical output. Entries without a
 * `<yt:videoId>` are skipped.
 */
export function parseYouTubeFeed(xml: string): YouTubeVideo[] {
  const source = xml ?? '';
  const videos: YouTubeVideo[] = [];
  const entries = source.match(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi) ?? [];
  for (const entry of entries) {
    const videoId = tagText(entry, 'yt:videoId');
    if (!videoId) continue;
    const title = tagText(entry, 'title') || videoId;
    const url = linkHref(entry, 'alternate') || linkHref(entry) || `https://www.youtube.com/watch?v=${videoId}`;
    const published = tagText(entry, 'published');
    videos.push({
      videoId,
      title,
      url,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      published,
    });
  }
  return videos;
}

/** Pure: find a `UC…` channel id anywhere in a channel HTML page. */
export function parseChannelId(html: string): string | undefined {
  const source = html ?? '';
  // Order matters: the page's OWN metadata first, then embedded JSON (which can
  // mention *recommended* channels before the page's own id).
  const patterns = [
    new RegExp(`itemprop="channelId"[^>]*content="(${CHANNEL_ID})"`, 'i'),
    new RegExp(`content="(${CHANNEL_ID})"[^>]*itemprop="channelId"`, 'i'),
    new RegExp(`<link[^>]+rel="canonical"[^>]+/channel/(${CHANNEL_ID})`, 'i'),
    new RegExp(`"externalId"\\s*:\\s*"(${CHANNEL_ID})"`),
    new RegExp(`"channelId"\\s*:\\s*"(${CHANNEL_ID})"`),
    new RegExp(`channel_id=(${CHANNEL_ID})`),
    new RegExp(`/channel/(${CHANNEL_ID})`),
  ];
  for (const re of patterns) {
    const match = re.exec(source);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/** Undo JSON string escaping inside a scraped `"content":"…"` value. */
function unescapeJson(value: string): string {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_all, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, ' ')
    .replace(/\\\//g, '/');
}

/**
 * Pure: pull the newest videos out of a channel `/videos` page.
 *
 * Used as a fallback — YouTube frequently answers the public RSS feed with a
 * 404, but the channel page itself still renders. In the page's JSON a video
 * lockup carries `"lockupMetadataViewModel":{"title":{"content":"…"}}`, with its
 * `"contentId"` a little further along.
 */
export function parseChannelVideosPage(html: string, max = 3): YouTubeVideo[] {
  const source = html ?? '';
  const titlePattern = /"lockupMetadataViewModel":\{"title":\{"content":"((?:[^"\\]|\\.)*)"/g;
  const found: { index: number; title: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = titlePattern.exec(source)) !== null) {
    const raw = match[1];
    if (!raw) continue;
    const title = decodeEntities(unescapeJson(raw));
    if (!title || /^shorts?$/i.test(title)) continue;
    found.push({ index: match.index, title });
  }

  const videos: YouTubeVideo[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < found.length; i += 1) {
    const entry = found[i];
    if (!entry) continue;
    // A video's `contentId` sits well *after* its title (metadata comes first),
    // so search up to the next lockup rather than a fixed window.
    const end = found[i + 1]?.index ?? Math.min(source.length, entry.index + 20_000);
    const videoId = /"contentId":"([A-Za-z0-9_-]{11})"/.exec(source.slice(entry.index, end))?.[1];
    if (!videoId || seen.has(videoId)) continue;
    seen.add(videoId);
    videos.push({
      videoId,
      title: entry.title,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      published: '',
    });
    if (videos.length >= Math.max(0, max)) break;
  }
  return videos;
}

async function fetchText(url: string, timeoutMs = 12000): Promise<string | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: {
          'user-agent': BROWSER_UA,
          accept: 'text/html,application/xhtml+xml,application/xml,text/xml',
        },
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
}

/** Candidate channel-page paths to try for a non-id input. */
function candidatePaths(input: string): string[] {
  const raw = input.trim();
  const isId = new RegExp(`^${CHANNEL_ID}$`).test(raw);
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const paths: string[] = [];
      const channelMatch = url.pathname.match(new RegExp(`/channel/(${CHANNEL_ID})`));
      if (channelMatch) return [`/channel/${channelMatch[1]}`];
      paths.push(`${url.pathname}${url.search}`);
      return paths;
    } catch {
      /* fall through to heuristic paths */
    }
  }
  const paths: string[] = [];
  if (raw.startsWith('@')) paths.push(`/${raw}`);
  else if (/^(channel|user|c)\//i.test(raw)) paths.push(`/${raw}`);
  else if (isId) return [];
  else paths.push(`/@${raw}`);
  paths.push(`https://www.youtube.com/results?search_query=${encodeURIComponent(raw)}`);
  return paths;
}

/**
 * Resolve `UC…` ids, `@handle`s, channel/user URLs or a bare name to a
 * channel id. Returns `undefined` when it cannot be determined.
 */
export async function resolveChannelId(input: string): Promise<string | undefined> {
  const raw = (input ?? '').trim();
  if (!raw) return undefined;
  if (new RegExp(`^${CHANNEL_ID}$`).test(raw)) return raw;

  const direct = new RegExp(`/channel/(${CHANNEL_ID})`).exec(raw);
  if (direct?.[1]) return direct[1];

  for (const path of candidatePaths(raw)) {
    const url = /^https?:\/\//i.test(path) ? path : `https://www.youtube.com${path}`;
    const html = await fetchText(url);
    if (!html) continue;
    const id = parseChannelId(html);
    if (id) return id;
  }
  return undefined;
}

/** Resolve a channel then read its Atom feed, returning up to `max` videos. */
export async function latestVideos(channelIdOrHandle: string, max = 3): Promise<YouTubeVideo[]> {
  const limit = Math.max(0, max);
  const channelId = await resolveChannelId(channelIdOrHandle);
  if (!channelId) return [];

  const xml = await fetchText(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
  );
  if (xml) {
    const parsed = parseYouTubeFeed(xml);
    if (parsed.length > 0) return parsed.slice(0, limit);
  }

  // The feed is often blocked (404) — the channel page still renders.
  const html = await fetchText(`https://www.youtube.com/channel/${channelId}/videos`);
  if (!html) return [];
  return parseChannelVideosPage(html, limit);
}

const WANT_LATEST = /(latest|newest|recent|last|naya|nayi|nayā|navin|abhi ka)/i;

const NOISE =
  /\b(play|open|chala|chalao|dikha|dikhao|kro|kr|kar|kardo|do|dena|de|de|please|plz|show|watch)\b/gi;

const FILLER =
  /\b(on|pe|par|from|se|me|mey|of|ka|ki|ke|s|youtube|yt|video|upload|uploaded|abhi|latest|newest|recent|last|naya|nayi|nayā|navin)\b/gi;

/**
 * "youtube pe MrBeast ka latest video play kr dena" → "MrBeast".
 *
 * Best-effort and deliberately conservative: anything that doesn't clearly
 * read as "the latest video of <channel>" returns `undefined`, so the message
 * simply flows to the model as usual.
 */
export function parseVideoRequest(text: string): string | undefined {
  const source = (text ?? '').trim();
  if (!source || !/video/i.test(source)) return undefined;
  if (!WANT_LATEST.test(source)) return undefined;
  const cleaned = source
    .replace(NOISE, ' ')
    .replace(FILLER, ' ')
    .replace(/[^\p{L}\p{N}\s@._-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length >= 2 ? cleaned : undefined;
}
