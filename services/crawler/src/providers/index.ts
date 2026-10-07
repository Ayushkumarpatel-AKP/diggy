import { BUILTIN_PROVIDER_NAME, createBuiltinProvider } from './builtin.js';
import { BROWSER_USE_PROVIDER_NAME, createBrowserUseProvider } from './browser-use.js';
import { CRAWL4AI_PROVIDER_NAME, createCrawl4aiProvider } from './crawl4ai.js';
import { FIRECRAWL_PROVIDER_NAME, createFirecrawlProvider } from './firecrawl.js';
import { REACH_PROVIDER_NAME, createReachProvider } from './reach.js';
import { PROVIDER_NAMES, readSettings, type CrawlProvider, type ProviderSettings } from './types.js';

/** Summary row returned by {@link listProviders}. */
export interface ProviderSummary {
  name: string;
  available: boolean;
}

function buildProviders(settings: ProviderSettings): CrawlProvider[] {
  return [
    createFirecrawlProvider(settings),
    createCrawl4aiProvider(settings),
    createBrowserUseProvider(settings),
    createReachProvider(),
    createBuiltinProvider(),
  ];
}

/**
 * List the historical provider set (`firecrawl`, `crawl4ai`, `browser-use`,
 * `builtin`) with their current availability.
 *
 * The `reach` capability layer is fully registered — {@link resolveProvider}
 * can select it by name and {@link listAllProviders} includes it — but it is
 * deliberately omitted here so the long-standing `/health` and `/providers`
 * payloads (and their consumers) keep their exact shape. The `/providers` and
 * `/health` routes surface `reach` separately.
 */
export function listProviders(settings: ProviderSettings = readSettings()): ProviderSummary[] {
  return buildProviders(settings)
    .filter((provider) => provider.name !== REACH_PROVIDER_NAME)
    .map((provider) => ({
      name: provider.name,
      available: provider.available(),
    }));
}

/** Every registered provider — including the `reach` capability layer. */
export function listAllProviders(settings: ProviderSettings = readSettings()): ProviderSummary[] {
  return buildProviders(settings).map((provider) => ({
    name: provider.name,
    available: provider.available(),
  }));
}

/**
 * Resolve the provider to use for a request.
 *
 * 1. The `preferred` provider by name, when it exists **and** is available.
 * 2. Otherwise the first available provider in preference order
 *    (`firecrawl` → `crawl4ai` → `browser-use`).
 * 3. Otherwise the always-available built-in Playwright provider.
 */
export function resolveProvider(
  preferred?: string,
  settings: ProviderSettings = readSettings(),
): CrawlProvider {
  const providers = buildProviders(settings);
  const builtin = providers.find((provider) => provider.name === BUILTIN_PROVIDER_NAME);
  if (!builtin) {
    // Defensive: buildProviders always appends builtin, so this is unreachable.
    return createBuiltinProvider();
  }

  const wanted = preferred?.trim().toLowerCase();
  if (wanted) {
    const match = providers.find((provider) => provider.name === wanted);
    if (match && match.available()) return match;
  }

  for (const name of PROVIDER_NAMES) {
    const provider = providers.find((candidate) => candidate.name === name);
    if (provider && provider.available()) return provider;
  }

  return builtin;
}

export { BUILTIN_PROVIDER_NAME, createBuiltinProvider } from './builtin.js';
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
export {
  DEFAULT_CRAWL4AI_URL,
  DEFAULT_FIRECRAWL_API_BASE,
  PROVIDER_NAMES,
  readSettings,
} from './types.js';
export {
  DOCTOR_TIMEOUT_MS,
  FEED_TIMEOUT_MS,
  JINA_READER_BASE,
  PROBE_TTL_MS,
  REACH_PROVIDER_NAME,
  TRANSCRIPT_TIMEOUT_MS,
  createReachProvider,
  fetchFeed,
  fetchTranscript,
  parseDoctorOutput,
  parseFeed,
  probeReach,
  reachChannelKey,
  reachProviderSummary,
  readWithReach,
  resetReachProbeCache,
  stripVtt,
} from './reach.js';
export type {
  FeedItem,
  FeedResult,
  ReachProbeResult,
  ReadResult,
  TranscriptResult,
} from './reach.js';
export type {
  CrawlInput,
  CrawlProvider,
  FetchLike,
  ProviderExtract,
  ProviderName,
  ProviderPage,
  ProviderSettings,
} from './types.js';
