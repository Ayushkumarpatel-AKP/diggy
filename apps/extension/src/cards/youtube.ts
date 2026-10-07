/**
 * YouTube helpers for video cards.
 *
 * `parseYouTubeFeed` is a PURE Atom parser (regex, no DOM) so it can be
 * unit-tested directly. `resolveChannelId` turns a channel id, `@handle`,
 * channel URL or bare name into a `UC…` id by reading the channel page.
 * `latestVideos` combines both: resolve the channel, then read its feed. If the
 * channel cannot be resolved at all it falls back to a plain web search, so a
 * well-known name ("mr beast") still finds its newest video.
 *
 * The network helpers never throw — they return `undefined` / `[]`.
 */
import { searchRemote } from '../web';

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

async function fetchText(url: string, timeoutMs = 30000): Promise<string | undefined> {
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
  else {
    paths.push(`/@${raw}`);
    // "mr beast" -> "@mrbeast"
    const compact = raw.replace(/\s+/g, '');
    if (compact !== raw) paths.push(`/@${compact}`);
  }
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
  if (channelId) {
    const xml = await fetchText(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
    );
    if (xml) {
      const parsed = parseYouTubeFeed(xml);
      if (parsed.length > 0) return parsed.slice(0, limit);
    }

    // The feed is often blocked (404) — the channel page still renders.
    const html = await fetchText(`https://www.youtube.com/channel/${channelId}/videos`);
    if (html) {
      const scraped = parseChannelVideosPage(html, limit);
      if (scraped.length > 0) return scraped;
    }
  }

  // Still nothing? Ask the web — this is what saves well-known-but-messy names.
  const searched = await searchLatestVideo(channelIdOrHandle);
  return searched ? [searched] : [];
}

function videoIdFromUrl(url: string): string | undefined {
  return (
    /[?&]v=([A-Za-z0-9_-]{11})/.exec(url)?.[1] ??
    /youtu\.be\/([A-Za-z0-9_-]{11})/.exec(url)?.[1] ??
    /\/shorts\/([A-Za-z0-9_-]{11})/.exec(url)?.[1]
  );
}

function fromVideoId(videoId: string, title = ''): YouTubeVideo {
  return {
    videoId,
    title: title || videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    published: '',
  };
}

/**
 * Does a search hit actually look like it belongs to `name`?
 *
 * Without this, a made-up name still returns whatever the search engine felt
 * like showing — worse than admitting we could not find it.
 */
function looksRelevant(name: string, haystack: string): boolean {
  const compact = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const flat = haystack.toLowerCase().replace(/[^a-z0-9]/g, '');
  // Strongest signal: the whole name with the spaces removed
  // ("mr beast" -> "mrbeast").
  if (compact.length >= 4 && flat.includes(compact)) return true;

  const words = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
  if (words.length === 0) return false;
  // A single generic word ("beast", "news", "music") matches half of YouTube and
  // used to hand back a completely unrelated video. Insist the whole name is
  // present and reasonably specific before trusting it.
  if (words.length === 1) return compact.length >= 7 && flat.includes(words[0]!);
  return words.every((token) => flat.includes(token));
}

/**
 * Last resort: find the newest video through several web searches.
 *
 * One query is not enough — engines rank differently and a single search often
 * surfaces a channel page or an old upload. We run a handful of phrasings, pool
 * every watch link we see, score them (relevance, result rank, "latest"-ness)
 * and hand back the top-ranked one.
 */
export async function searchLatestVideo(name: string): Promise<YouTubeVideo | undefined> {
  const clean = (name ?? '').trim();
  if (!clean) return undefined;

  const queries = [
    `${clean} latest video`,
    `${clean} new video`,
    `${clean} latest video youtube`,
    `site:youtube.com ${clean}`,
    `${clean} youtube`,
  ];

  const candidates = new Map<string, { video: YouTubeVideo; score: number }>();

  for (const query of queries) {
    let hits: Awaited<ReturnType<typeof searchRemote>> = [];
    try {
      hits = await searchRemote(query, 10);
    } catch {
      continue;
    }

    for (const [index, hit] of hits.entries()) {
      const videoId = videoIdFromUrl(hit.url);
      if (!videoId) continue;
      const haystack = `${hit.title} ${hit.snippet} ${hit.url}`;

      let score = Math.max(0, 10 - index); // earlier results rank higher
      if (looksRelevant(clean, haystack)) score += 8;
      if (/latest|newest|\bnew\b|recent|updated/i.test(haystack)) score += 3;
      if (/channel|playlist|shorts/i.test(hit.url)) score -= 4;

      const previous = candidates.get(videoId);
      if (previous && previous.score >= score) continue;
      const cleanTitle = decodeEntities(hit.title.replace(/\s*[-–]\s*YouTube\s*$/i, ''));
      candidates.set(videoId, {
        video: fromVideoId(videoId, cleanTitle),
        score,
      });
    }

    // A strong, relevant hit is enough — no need to hammer the search engine.
    const best = [...candidates.values()].sort((a, b) => b.score - a.score)[0];
    if (best && best.score >= 16) break;
  }

  const ranked = [...candidates.values()].sort((a, b) => b.score - a.score);
  return ranked[0]?.video;
}

const WANT_LATEST = /(latest|newest|recent|last|new|fresh|naya|nayi|nayā|navin|abhi ka)/i;

/** "play / open / show" plus common Hindi equivalents — an explicit ask, so "latest" is implied. */
const PLAY_VERB = /\b(khol|kholo|kholna|chala|chalao|chalo|dikha|dikhao|play|open|show|sunao|dekhna|dekh)\b/i;

/** People say "video" in many shapes — and typo it. */
const VIDEO_WORD = /(video|vdo|vid|cideo|clip|youtube|\byt\b)/i;

const NOISE =
  /\b(play|open|chala|chalao|chalo|dikha|dikhao|khol|kholo|kholna|kholdo|lagao|laga|sunao|bhej|bhejo|dekhna|dekh|kro|kr|kar|kardo|do|dena|de|please|plz|show|watch|mujhe|me|mai|main)\b/gi;

const FILLER =
  /\b(on|pe|par|from|se|me|mey|of|ka|ki|ke|s|youtube|yt|video|vdo|vid|cideo|clip|upload|uploaded|abhi|latest|newest|recent|last|new|fresh|naya|nayi|nayā|navin)\b/gi;

/**
 * "play MrBeast's latest video on YouTube" → "MrBeast".
 *
 * Best-effort and deliberately conservative: anything that doesn't clearly
 * read as "the latest video of <channel>" returns `undefined`, so the message
 * simply flows to the model as usual.
 */
/**
 * Times and dates are never part of a name: "open the MrBeast video at 2.28 pm"
 * must resolve "MrBeast", not "mr beast 2.28 pm" (which matched nothing and
 * handed back a random video).
 *
 * Deliberately conservative — a bare number is left alone so "5 Minute Crafts"
 * survives; only a number with am/pm, a "baje" clock, or a day word is dropped.
 */
const WHEN =
  /\b\d{1,2}([.:]\d{2})?\s*(am|pm|a\.m|p\.m)\b|\b\d{1,2}\s*(baje|o'?clock)\b|\b(today|tonight|tomorrow|morning|evening|night|kal|aaj|shaam|subah)\b/gi;

export function parseVideoRequest(text: string): string | undefined {
  const source = (text ?? '').trim();
  if (!source || !VIDEO_WORD.test(source)) return undefined;
  // "latest" is implied by an explicit ask ("mr beast ka video kholo").
  if (!WANT_LATEST.test(source) && !PLAY_VERB.test(source)) return undefined;
  const cleaned = source
    .replace(WHEN, ' ')
    .replace(NOISE, ' ')
    .replace(FILLER, ' ')
    .replace(/[^\p{L}\p{N}\s@._-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // A name made only of numbers/separators is not a channel.
  if (cleaned.length < 2 || !/\p{L}/u.test(cleaned)) return undefined;
  return cleaned;
}
