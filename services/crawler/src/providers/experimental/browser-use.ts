import { asRecord, asString, callFetch, readJson } from '../http.js';
import {
  type CrawlInput,
  type CrawlProvider,
  type FetchLike,
  type ProviderExtract,
  type ProviderPage,
  type ProviderSettings,
} from '../types.js';

export const BROWSER_USE_PROVIDER_NAME = 'browser-use';

/** Options for {@link createBrowserUseProvider}. */
export interface BrowserUseOptions extends ProviderSettings {
  /** Injectable fetch (used by tests); defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
}

const RESULT_KEYS = [
  'result',
  'output',
  'final_result',
  'extracted_content',
  'markdown',
  'content',
  'text',
  'message',
] as const;

const NESTED_KEYS = ['steps', 'history', 'actions', 'data'] as const;

/** Recursively pull the best-effort text payload out of a browser-use response. */
function textFrom(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (Array.isArray(payload)) {
    return payload
      .map((entry) => textFrom(entry))
      .filter((value) => value.length > 0)
      .join('\n\n');
  }
  const obj = asRecord(payload);
  for (const key of RESULT_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  for (const key of NESTED_KEYS) {
    const value = obj[key];
    if (value !== undefined) {
      const nested = textFrom(value);
      if (nested) return nested;
    }
  }
  return '';
}

function titleFrom(payload: unknown, fallback: string): string {
  const obj = asRecord(payload);
  return asString(obj.title) ?? asString(obj.page_title) ?? asString(obj.name) ?? fallback;
}

/**
 * Adapter for a `browser-use` HTTP service that runs an agentic browser task.
 *
 * Posts `{ task, url }` to `POST {BROWSER_USE_URL}/run` and returns the agent's
 * textual result as Markdown. Primarily an **extraction** provider: `crawl()`
 * runs a single agentic task for the seed URL and returns one page. `available()`
 * is `true` only when `BROWSER_USE_URL` is configured.
 */
export function createBrowserUseProvider(options: BrowserUseOptions): CrawlProvider {
  const base = (options.browserUseUrl ?? '').replace(/\/+$/, '');
  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  async function run(task: string, url: string): Promise<unknown> {
    const response = await callFetch(
      fetchImpl,
      `${base}/run`,
      { method: 'POST', headers, body: JSON.stringify({ task, url }) },
      'browser-use',
    );
    return readJson<unknown>(response, 'browser-use run');
  }

  function taskFor(url: string): string {
    return `Open ${url} and return its main content as clean, readable Markdown.`;
  }

  async function extract(url: string): Promise<ProviderExtract> {
    const payload = await run(taskFor(url), url);
    const markdown = textFrom(payload);
    if (!markdown.trim()) {
      throw new Error(`browser-use returned no content for ${url}.`);
    }
    return { title: titleFrom(payload, url), markdown };
  }

  async function crawl(input: CrawlInput): Promise<ProviderPage[]> {
    const extracted = await extract(input.url);
    return [{ url: input.url, title: extracted.title, markdown: extracted.markdown }];
  }

  return {
    name: BROWSER_USE_PROVIDER_NAME,
    available: () => Boolean(base),
    crawl,
    extract,
  };
}

/** Decode a browser-use response body into text (exported for unit tests). */
export function parseBrowserUseResult(payload: unknown, fallbackUrl: string): ProviderExtract {
  return { title: titleFrom(payload, fallbackUrl), markdown: textFrom(payload) };
}
