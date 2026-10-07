import { crawl, fetchPageHtml } from '../crawl.js';
import { extractFromHtml } from '../extract.js';
import { TOTAL_TIMEOUT_MS } from '../ssrf.js';
import type { CrawlInput, CrawlProvider, ProviderExtract, ProviderPage } from './types.js';

export const BUILTIN_PROVIDER_NAME = 'builtin';

/**
 * Wrap the in-process Playwright crawler (`src/crawl.ts`) and Readability
 * extractor (`src/extract.ts`) behind the {@link CrawlProvider} interface.
 *
 * This is the always-available default and needs no configuration or network
 * credentials — it is what the service uses when no external provider is
 * configured.
 */
export function createBuiltinProvider(): CrawlProvider {
  return {
    name: BUILTIN_PROVIDER_NAME,
    available: () => true,
    async crawl(input: CrawlInput): Promise<ProviderPage[]> {
      return crawl({
        url: input.url,
        depth: input.depth,
        maxPages: input.maxPages,
        timeoutMs: input.timeoutMs,
      });
    },
    async extract(url: string): Promise<ProviderExtract> {
      const html = await fetchPageHtml(url, { timeoutMs: TOTAL_TIMEOUT_MS });
      return extractFromHtml(html, url);
    },
  };
}
