import {
  asRecord,
  asString,
  callFetch,
  delay,
  readJson,
} from './http.js';
import {
  DEFAULT_FIRECRAWL_API_BASE,
  type CrawlInput,
  type CrawlProvider,
  type FetchLike,
  type ProviderExtract,
  type ProviderPage,
  type ProviderSettings,
} from './types.js';

export const FIRECRAWL_PROVIDER_NAME = 'firecrawl';

/** Options for {@link createFirecrawlProvider}. */
export interface FirecrawlOptions extends ProviderSettings {
  /** Injectable fetch (used by tests); defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Delay between crawl-status polls, in ms (default 1000). */
  pollIntervalMs?: number;
  /** Overall timeout for a crawl job, in ms (default 120000). */
  pollTimeoutMs?: number;
}

interface FirecrawlMetadata {
  title?: unknown;
  sourceURL?: unknown;
  url?: unknown;
  [key: string]: unknown;
}

interface FirecrawlDocument {
  markdown?: unknown;
  content?: unknown;
  html?: unknown;
  url?: unknown;
  title?: unknown;
  metadata?: FirecrawlMetadata | null;
  [key: string]: unknown;
}

interface FirecrawlScrapeResponse {
  success?: unknown;
  data?: FirecrawlDocument | null;
  error?: unknown;
}

interface FirecrawlCrawlStartResponse {
  success?: unknown;
  id?: unknown;
  error?: unknown;
}

interface FirecrawlCrawlStatusResponse {
  success?: unknown;
  status?: unknown;
  data?: FirecrawlDocument[] | null;
  error?: unknown;
  [key: string]: unknown;
}

function mapDocument(doc: FirecrawlDocument, fallbackUrl: string): ProviderPage {
  const metadata: FirecrawlMetadata = doc.metadata ?? {};
  const url =
    asString(metadata.sourceURL) ?? asString(metadata.url) ?? asString(doc.url) ?? fallbackUrl;
  const title = asString(metadata.title) ?? asString(doc.title) ?? url;
  const markdown = asString(doc.markdown) ?? asString(doc.content) ?? '';
  return { url, title, markdown };
}

/**
 * Adapter for the hosted Firecrawl API.
 *
 * - `crawl()` starts `POST {base}/v1/crawl`, then polls `GET {base}/v1/crawl/{id}`
 *   until the job completes and maps every scraped document to the shared shape.
 * - `extract()` calls the simpler `POST {base}/v1/scrape` for a single page.
 *
 * The base URL comes from `FIRECRAWL_API_BASE` (default
 * `https://api.firecrawl.dev`) and the bearer token from `FIRECRAWL_API_KEY`.
 * `available()` is `true` only when a key is configured.
 */
export function createFirecrawlProvider(options: FirecrawlOptions): CrawlProvider {
  const apiKey = options.firecrawlApiKey;
  const base = (options.firecrawlApiBase ?? DEFAULT_FIRECRAWL_API_BASE).replace(/\/+$/, '');
  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? 1000);
  const pollTimeoutMs = Math.max(0, options.pollTimeoutMs ?? 120000);

  const authHeaders: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const jsonHeaders: Record<string, string> = {
    'content-type': 'application/json',
    ...authHeaders,
  };

  function request(path: string, init: RequestInit): Promise<Response> {
    return callFetch(fetchImpl, `${base}${path}`, init, 'Firecrawl');
  }

  async function scrape(url: string): Promise<ProviderExtract> {
    const response = await request('/v1/scrape', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ url, formats: ['markdown'] }),
    });
    const payload = await readJson<FirecrawlScrapeResponse>(response, 'Firecrawl scrape');
    const data = payload.data;
    if (!data) {
      throw new Error('Firecrawl scrape returned no data.');
    }
    const page = mapDocument(data, url);
    return { title: page.title, markdown: page.markdown };
  }

  async function crawl(input: CrawlInput): Promise<ProviderPage[]> {
    const maxPages = Math.max(1, input.maxPages ?? 20);
    const startResponse = await request('/v1/crawl', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        url: input.url,
        limit: maxPages,
        ...(typeof input.depth === 'number' ? { maxDiscoveryDepth: input.depth } : {}),
      }),
    });
    const start = await readJson<FirecrawlCrawlStartResponse>(startResponse, 'Firecrawl crawl');
    const id = asString(start.id);
    if (!id) {
      throw new Error('Firecrawl crawl did not return a job id.');
    }

    const deadline = Date.now() + pollTimeoutMs;
    for (;;) {
      const statusResponse = await request(`/v1/crawl/${encodeURIComponent(id)}`, {
        headers: authHeaders,
      });
      const status = await readJson<FirecrawlCrawlStatusResponse>(
        statusResponse,
        'Firecrawl crawl status',
      );
      const state = asString(status.status);

      if (state === 'completed') {
        const docs = Array.isArray(status.data) ? status.data : [];
        return docs.map((doc) => mapDocument(doc, input.url));
      }
      if (state === 'failed' || state === 'cancelled') {
        const detail = asString(status.error);
        throw new Error(`Firecrawl crawl ${id} ${state}${detail ? `: ${detail}` : '.'}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for Firecrawl crawl ${id} to finish.`);
      }
      await delay(pollIntervalMs);
    }
  }

  return {
    name: FIRECRAWL_PROVIDER_NAME,
    available: () => Boolean(apiKey),
    crawl,
    extract: scrape,
  };
}

/**
 * Decode a Firecrawl scrape response body into the shared extract shape.
 * Exported for unit testing without touching the network.
 */
export function mapFirecrawlDocument(doc: unknown, fallbackUrl: string): ProviderPage {
  return mapDocument(asRecord(doc) as FirecrawlDocument, fallbackUrl);
}
