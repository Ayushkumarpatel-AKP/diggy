/**
 * Self-contained web tools for the background worker.
 *
 * The assistant must be able to look things up on its own instead of telling
 * the user to open a tab. These helpers run entirely in the service worker:
 *  - `fetchReadable` / `extractRemote` fetch and clean any URL
 *  - `searchRemote` searches the web (the local crawler service when it is
 *    running, otherwise a direct DuckDuckGo HTML fetch)
 *  - `checkWatch` polls one watched page and reports whether it changed
 *
 * The extension has `<all_urls>` host permission, so the background `fetch`
 * can hit any origin without CORS problems.
 */
import { CRAWLER_DEFAULT_URL } from '@diggy/shared';
import { getSettings } from './storage';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Strip a raw HTML document down to readable plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function titleOf(html: string, fallback: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match ? htmlToText(match[1]).replace(/\n/g, ' ').trim() : '';
  return title || fallback;
}

async function fetchHtml(url: string, timeoutMs = 12000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch any URL and return a cleaned, truncated page. */
export async function fetchReadable(url: string, maxChars = 20000): Promise<FetchedPage> {
  const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const html = await fetchHtml(normalized);
  const text = htmlToText(html).slice(0, maxChars);
  return { url: normalized, title: titleOf(html, normalized), text };
}

async function crawlerBase(): Promise<string> {
  try {
    const { crawlerUrl } = await getSettings();
    return (crawlerUrl || CRAWLER_DEFAULT_URL).replace(/\/$/, '');
  } catch {
    return CRAWLER_DEFAULT_URL;
  }
}

/** Extract a URL using the local crawler service (Readability) when available. */
export async function extractRemote(url: string): Promise<FetchedPage> {
  try {
    const base = await crawlerBase();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const response = await fetch(`${base}/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (response.ok) {
      const payload = (await response.json()) as { title?: string; markdown?: string };
      if (payload.markdown && payload.markdown.trim()) {
        return { url, title: payload.title || url, text: payload.markdown.slice(0, 20000) };
      }
    }
  } catch {
    /* fall through to the built-in fetch */
  }
  return fetchReadable(url);
}

function cleanText(value: string): string {
  return htmlToText(value).replace(/\s+/g, ' ').trim();
}

function decodeDdg(url: string): string {
  try {
    const absolute = new URL(url, 'https://duckduckgo.com');
    const target = absolute.searchParams.get('uddg');
    return target ?? absolute.toString();
  } catch {
    return url;
  }
}

/** Parse DuckDuckGo's HTML results page without a DOM. */
export function parseDuckDuckGo(html: string, max = 8): SearchHit[] {
  const anchors = [
    ...html.matchAll(
      /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    ),
  ];
  const snippets = [
    ...html.matchAll(/<a\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi),
  ];
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  anchors.forEach((match, index) => {
    if (hits.length >= max) return;
    const url = decodeDdg(match[1]);
    if (!/^https?:/i.test(url) || seen.has(url)) return;
    seen.add(url);
    hits.push({
      title: cleanText(match[2]) || url,
      url,
      snippet: cleanText(snippets[index]?.[1] ?? ''),
    });
  });
  return hits;
}

/** Search the web: the crawler service first, then a direct DuckDuckGo fetch. */
export async function searchRemote(query: string, max = 8): Promise<SearchHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  try {
    const base = await crawlerBase();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const response = await fetch(`${base}/search?q=${encodeURIComponent(trimmed)}`, {
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (response.ok) {
      const payload = (await response.json()) as { results?: SearchHit[] };
      if (Array.isArray(payload.results) && payload.results.length > 0) {
        return payload.results.slice(0, max);
      }
    }
  } catch {
    /* fall through */
  }
  const html = await fetchHtml(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(trimmed)}`,
  );
  return parseDuckDuckGo(html, max);
}

async function hashText(text: string): Promise<string> {
  try {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // Cheap fallback hash if WebCrypto is unavailable.
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
    return String(hash);
  }
}

export interface WatchCheckResult {
  page: FetchedPage;
  hash: string;
  /** Present when a keyword was configured. */
  matched?: boolean;
}

/** Fetch a watched page and hash it (plus an optional keyword test). */
export async function checkWatch(url: string, keyword?: string): Promise<WatchCheckResult> {
  const page = await extractRemote(url);
  const hash = await hashText(page.text);
  const needle = keyword?.trim().toLowerCase();
  return {
    page,
    hash,
    matched: needle ? page.text.toLowerCase().includes(needle) : undefined,
  };
}
