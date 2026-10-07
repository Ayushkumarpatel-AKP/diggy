/**
 * Opt-in, experimental provider adapters.
 *
 * These three adapters (`firecrawl`, `crawl4ai`, `browser-use`) talk to paid
 * third-party vendors and are only verified against mocks today, so they are
 * **not** part of the default provider surface. Import them directly, or opt in
 * wholesale with {@link experimentalProviders} in `../index.ts`.
 */
export {
  BROWSER_USE_PROVIDER_NAME,
  createBrowserUseProvider,
  parseBrowserUseResult,
} from './browser-use.js';
export type { BrowserUseOptions } from './browser-use.js';
export { CRAWL4AI_PROVIDER_NAME, createCrawl4aiProvider, mapCrawl4aiItem } from './crawl4ai.js';
export type { Crawl4aiOptions } from './crawl4ai.js';
export {
  FIRECRAWL_PROVIDER_NAME,
  createFirecrawlProvider,
  mapFirecrawlDocument,
} from './firecrawl.js';
export type { FirecrawlOptions } from './firecrawl.js';
