/**
 * Page metadata (Open Graph / Twitter / favicon) for link-preview cards.
 *
 * `parsePageMeta` is a PURE regex parser — no DOM, no DOMParser — so it runs
 * identically in the service worker and unit tests. `fetchPageMeta` pairs it
 * with a background fetch and never throws (best-effort metadata).
 */
import { faviconUrlFor } from './favicon';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface PageMeta {
  title: string;
  description?: string;
  image?: string;
  faviconUrl?: string;
}

/** Decode the small set of entities that appear in titles/descriptions. */
function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function firstMatch(html: string, re: RegExp): string | undefined {
  const match = re.exec(html);
  return match ? decodeEntities(match[1]) : undefined;
}

/** Parse every attribute on a tag into a lowercase-keyed record. */
function parseAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(tag))) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[3] ?? match[4] ?? match[5] ?? '');
  }
  return attrs;
}

/** Resolve a possibly relative URL against the page URL; `undefined` if bad. */
function absolutize(value: string | undefined, base: string): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value, base).toString();
  } catch {
    return undefined;
  }
}

/** Prefer `property` (Open Graph) then `name` (Twitter / standard) metadata. */
function metaContent(metas: Record<string, string>[], keys: string[]): string | undefined {
  for (const key of keys) {
    for (const meta of metas) {
      const prop = meta['property'];
      const name = meta['name'];
      if (prop === key || name === key) {
        const content = meta['content'];
        if (content) return content;
      }
    }
  }
  return undefined;
}

/**
 * Extract title / description / image / favicon from raw HTML.
 * Pure: same input always yields the same output. Never throws.
 */
export function parsePageMeta(html: string, url: string): PageMeta {
  const source = html ?? '';
  const base = resolveBase(url);
  const metas = (source.match(/<meta\b[^>]*>/gi) ?? []).map(parseAttributes);

  const ogTitle = metaContent(metas, ['og:title', 'twitter:title']);
  const titleTag = firstMatch(source, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const fallbackTitle = hostOf(url) || url;
  const title = ogTitle || titleTag || fallbackTitle;

  const description = metaContent(metas, ['og:description', 'twitter:description', 'description']);

  const rawImage = metaContent(metas, ['og:image', 'og:image:secure_url', 'twitter:image']);
  const image = absolutize(rawImage, base);

  return {
    title,
    description,
    image,
    faviconUrl: findFavicon(source, base) ?? faviconUrlFor(url),
  };
}

function resolveBase(url: string): string {
  const value = (url ?? '').trim();
  if (/^https?:\/\//i.test(value)) return value;
  return value ? `https://${value}` : 'https://localhost';
}

function hostOf(url: string): string {
  try {
    return new URL(resolveBase(url)).hostname;
  } catch {
    return '';
  }
}

/** Find the first `<link rel="...icon...">` href and resolve it. */
function findFavicon(html: string, base: string): string | undefined {
  const links = html.match(/<link\b[^>]*>/gi) ?? [];
  let best: string | undefined;
  for (const tag of links) {
    const attrs = parseAttributes(tag);
    const rel = (attrs['rel'] ?? '').toLowerCase();
    if (!rel.split(/\s+/).some((token) => token.includes('icon'))) continue;
    const href = absolutize(attrs['href'], base);
    if (!href) continue;
    // Prefer a plain `icon` / `shortcut icon` over `apple-touch-icon`.
    if (rel === 'icon' || rel === 'shortcut icon') return href;
    best ??= href;
  }
  return best;
}

/**
 * Fetch a URL and parse its metadata. Never throws — returns whatever it can
 * (with the favicon fallback) even when the page is unreachable.
 */
export async function fetchPageMeta(url: string): Promise<PageMeta> {
  const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  let html = '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(normalized, {
        headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml' },
        signal: controller.signal,
      });
      if (response.ok) html = await response.text();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    /* best-effort: fall through with empty html */
  }
  try {
    return parsePageMeta(html, normalized);
  } catch {
    return { title: hostOf(normalized) || normalized, faviconUrl: faviconUrlFor(normalized) };
  }
}
