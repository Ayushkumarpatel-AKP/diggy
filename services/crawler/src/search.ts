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

/**
 * Keyless web search backed by DuckDuckGo's HTML endpoint.
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

  const endpoint = options.endpoint ?? DUCKDUCKGO_HTML_ENDPOINT;
  const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}q=${encodeURIComponent(q)}`;
  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`DuckDuckGo search failed with HTTP ${response.status}`);
    }
    const html = await response.text();
    return parseDuckDuckGoHtml(html, { maxResults: options.maxResults });
  } finally {
    clearTimeout(timer);
  }
}
