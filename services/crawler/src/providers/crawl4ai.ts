import {
  asRecord,
  asString,
  callFetch,
  readJson,
  tryParseJson,
} from './http.js';
import {
  type CrawlInput,
  type CrawlProvider,
  type FetchLike,
  type ProviderExtract,
  type ProviderPage,
  type ProviderSettings,
} from './types.js';

export const CRAWL4AI_PROVIDER_NAME = 'crawl4ai';

/** Options for {@link createCrawl4aiProvider}. */
export interface Crawl4aiOptions extends ProviderSettings {
  /** Injectable fetch (used by tests); defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
}

function mapItem(item: unknown, fallbackUrl: string): ProviderPage {
  const obj = asRecord(item);
  const metadata = asRecord(obj.metadata);
  const url =
    asString(obj.url) ??
    asString(metadata.url) ??
    asString(obj.final_url) ??
    asString(obj.source_url) ??
    fallbackUrl;
  const title =
    asString(metadata.title) ?? asString(obj.title) ?? asString(obj.headline) ?? url;
  const markdown =
    asString(obj.markdown) ??
    asString(obj.fit_markdown) ??
    asString(obj.md) ??
    asString(obj.cleaned_html) ??
    asString(obj.text) ??
    '';
  return { url, title, markdown };
}

/** Pull the array of per-page result objects out of a Crawl4AI response. */
function collectItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const obj = asRecord(payload);
  for (const key of ['results', 'data', 'items', 'pages']) {
    const value = obj[key];
    if (Array.isArray(value)) return value;
  }
  // A single-page response (e.g. `{ markdown }`) is treated as one result.
  if (
    typeof obj.markdown === 'string' ||
    typeof obj.fit_markdown === 'string' ||
    typeof obj.cleaned_html === 'string' ||
    typeof obj.html === 'string'
  ) {
    return [obj];
  }
  return [];
}

/**
 * Adapter for a self-hosted Crawl4AI server.
 *
 * - `crawl()` posts `{ urls: [url] }` to `POST {CRAWL4AI_URL}/crawl` and maps the
 *   returned results to the shared shape.
 * - `extract()` prefers the lighter `POST {CRAWL4AI_URL}/md` endpoint and falls
 *   back to `/crawl` when the deployment does not expose it.
 *
 * `available()` is `true` only when `CRAWL4AI_URL` is configured.
 */
export function createCrawl4aiProvider(options: Crawl4aiOptions): CrawlProvider {
  const base = (options.crawl4aiUrl ?? '').replace(/\/+$/, '');
  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  function request(path: string, body: unknown): Promise<Response> {
    return callFetch(
      fetchImpl,
      `${base}${path}`,
      { method: 'POST', headers, body: JSON.stringify(body) },
      'Crawl4AI',
    );
  }

  async function crawl(input: CrawlInput): Promise<ProviderPage[]> {
    const response = await request('/crawl', {
      urls: [input.url],
      ...(typeof input.maxPages === 'number' ? { max_pages: input.maxPages } : {}),
      ...(typeof input.depth === 'number' ? { depth: input.depth } : {}),
    });
    const payload = await readJson<unknown>(response, 'Crawl4AI crawl');
    return collectItems(payload).map((item) => mapItem(item, input.url));
  }

  async function extractFromMdEndpoint(url: string): Promise<ProviderExtract | null> {
    let response: Response;
    try {
      response = await request('/md', { url, f: 'markdown' });
    } catch {
      return null;
    }
    const text = await response.text();
    if (!response.ok) return null;

    const parsed = tryParseJson(text);
    if (parsed !== undefined) {
      const obj = asRecord(parsed);
      const markdown =
        asString(obj.markdown) ??
        asString(obj.md) ??
        asString(obj.fit_markdown) ??
        asString(obj.text);
      if (markdown) {
        const title = asString(asRecord(obj.metadata).title) ?? asString(obj.title) ?? url;
        return { title, markdown };
      }
      return null;
    }
    return text.trim() ? { title: url, markdown: text } : null;
  }

  async function extract(url: string): Promise<ProviderExtract> {
    const viaMd = await extractFromMdEndpoint(url);
    if (viaMd) return viaMd;

    const pages = await crawl({ url, depth: 0, maxPages: 1 });
    const first = pages[0];
    if (!first) {
      throw new Error(`Crawl4AI returned no content for ${url}.`);
    }
    return { title: first.title, markdown: first.markdown };
  }

  return {
    name: CRAWL4AI_PROVIDER_NAME,
    available: () => Boolean(base),
    crawl,
    extract,
  };
}

/** Map a Crawl4AI result item into the shared page shape (exported for tests). */
export function mapCrawl4aiItem(item: unknown, fallbackUrl: string): ProviderPage {
  return mapItem(item, fallbackUrl);
}
