import { JSDOM } from 'jsdom';
import type { FetchLike } from './providers/types.js';

/** A single web-search hit. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Options accepted by {@link searchWeb}. */
export interface SearchOptions {
  /** Maximum number of results to return (default 10). */
  maxResults?: number;
  /** Request timeout in ms (default 10000). */
  timeoutMs?: number;
  /** Override the DuckDuckGo HTML endpoint (used by tests). */
  endpoint?: string;
  /** Injectable fetch (used by tests); defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Bypass the offline guard — only ever used with an injected `fetchImpl`. */
  allowNetwork?: boolean;
}

export const DUCKDUCKGO_HTML_ENDPOINT = 'https://html.duckduckgo.com/html/';
export const BING_ENDPOINT = 'https://www.bing.com/search';
export const MAX_SEARCH_RESULTS = 10;

// A realistic browser User-Agent: DuckDuckGo serves an empty/challenge page to
// obvious bot agents, so a plain fetch UA silently yields zero results.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Whether outbound network access should be suppressed. `true` during tests
 * (Vitest / `NODE_ENV=test`) and whenever `DIGGY_OFFLINE` is set, so the search
 * route can never reach the network in CI.
 */
export function isNetworkDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.DIGGY_OFFLINE ?? env.DIGGY_DISABLE_NETWORK;
  if (flag === '1' || flag === 'true') return true;
  return env.NODE_ENV === 'test' || env.VITEST === 'true';
}

/** Resolve a DuckDuckGo result href, unwrapping the `uddg` redirect parameter. */
export function decodeDuckDuckGoUrl(href: string, base = 'https://duckduckgo.com'): string {
  try {
    const absolute = new URL(href, base);
    const uddg = absolute.searchParams.get('uddg');
    if (uddg) return uddg;
    return absolute.toString();
  } catch {
    return href;
  }
}

function clean(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Parse DuckDuckGo's HTML search page into structured results. Pure and
 * offline — exported so it can be exercised with a fixture in tests.
 */
export function parseDuckDuckGoHtml(
  html: string,
  options: { maxResults?: number } = {},
): SearchResult[] {
  const max = Math.max(1, options.maxResults ?? MAX_SEARCH_RESULTS);
  const dom = new JSDOM(html);
  const document = dom.window.document;

  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const node of Array.from(document.querySelectorAll('.result, .web-result'))) {
    if (results.length >= max) break;

    const anchor = node.querySelector('a.result__a') ?? node.querySelector('a[href]');
    if (!anchor) continue;

    const href = anchor.getAttribute('href');
    if (!href) continue;

    const url = decodeDuckDuckGoUrl(href);
    if (!/^https?:/i.test(url)) continue;
    if (seen.has(url)) continue;

    const title = clean(anchor.textContent) || url;
    const snippet = clean(node.querySelector('.result__snippet')?.textContent);

    seen.add(url);
    results.push({ title, url, snippet });
  }

  return results;
}

/** Unwrap Bing's `bing.com/ck/a?...&u=a1<base64>` click-tracking link. */
export function decodeBingUrl(href: string): string {
  try {
    const url = new URL(href, 'https://www.bing.com');
    if (!/bing\.com$/i.test(url.hostname)) return url.toString();
    const u = url.searchParams.get('u');
    if (!u) return url.toString();
    const encoded = u.startsWith('a1') ? u.slice(2) : u;
    const decoded = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return /^https?:\/\//i.test(decoded) ? decoded : url.toString();
  } catch {
    return href;
  }
}

/**
 * Parse Bing's HTML results. Pure and offline — exported for tests.
 *
 * Used as a fallback: DuckDuckGo's HTML endpoint answers heavily-rate-limited
 * clients with a challenge page (or a 5xx), which used to leave every search
 * empty.
 */
export function parseBingHtml(
  html: string,
  options: { maxResults?: number } = {},
): SearchResult[] {
  const max = Math.max(1, options.maxResults ?? MAX_SEARCH_RESULTS);
  const dom = new JSDOM(html);
  const document = dom.window.document;

  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const node of Array.from(document.querySelectorAll('li.b_algo'))) {
    if (results.length >= max) break;
    const anchor = node.querySelector('h2 a[href]') ?? node.querySelector('a[href]');
    const href = anchor?.getAttribute('href');
    if (!href) continue;
    const url = decodeBingUrl(href);
    if (!/^https?:/i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: clean(anchor?.textContent) || url,
      url,
      snippet: clean(node.querySelector('.b_caption p, .b_lineclamp2, p')?.textContent),
    });
  }

  return results;
}

/**
 * Keyless web search backed by DuckDuckGo's HTML endpoint, with a Bing
 * fallback.
 *
 * Returns `{title, url, snippet}[]` (at most {@link MAX_SEARCH_RESULTS}). When
 * the network is disabled (tests / `DIGGY_OFFLINE`) this resolves to `[]`
 * without performing any request.
 */
export async function searchWeb(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  if (!options.allowNetwork && isNetworkDisabled()) return [];

  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10000;

  const attempt = async (url: string): Promise<string | undefined> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.9',
        },
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      return await response.text();
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };

  const endpoint = options.endpoint ?? DUCKDUCKGO_HTML_ENDPOINT;
  const duckUrl = `${endpoint}${endpoint.includes('?') ? '&' : '?'}q=${encodeURIComponent(q)}`;
  const duckHtml = await attempt(duckUrl);
  const fromDuck = duckHtml ? parseDuckDuckGoHtml(duckHtml, { maxResults: options.maxResults }) : [];
  if (fromDuck.length > 0) return fromDuck;

  // An explicit endpoint means a test fixture — never reach out to Bing.
  if (options.endpoint) return fromDuck;
  if (!options.allowNetwork && isNetworkDisabled()) return [];

  const bingHtml = await attempt(`${BING_ENDPOINT}?q=${encodeURIComponent(q)}`);
  return bingHtml ? parseBingHtml(bingHtml, { maxResults: options.maxResults }) : fromDuck;
}
