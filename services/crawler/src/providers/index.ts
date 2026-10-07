import { BUILTIN_PROVIDER_NAME, createBuiltinProvider } from './builtin.js';
import {
  BROWSER_USE_PROVIDER_NAME,
  createBrowserUseProvider,
} from './experimental/browser-use.js';
import { CRAWL4AI_PROVIDER_NAME, createCrawl4aiProvider } from './experimental/crawl4ai.js';
import { FIRECRAWL_PROVIDER_NAME, createFirecrawlProvider } from './experimental/firecrawl.js';
import { REACH_PROVIDER_NAME, createReachProvider } from './reach.js';
import { readSettings, type CrawlProvider, type ProviderSettings } from './types.js';

/** Summary row returned by {@link listProviders}. */
export interface ProviderSummary {
  name: string;
  /** Whether the provider is usable **as a registered backend** right now. */
  available: boolean;
  /**
   * Set on the opt-in, paid-vendor adapters (`firecrawl`, `crawl4ai`,
   * `browser-use`). They are still listed so they remain discoverable, but they
   * are never part of the default provider surface and are always reported
   * `available: false` — opt them in with {@link experimentalProviders}.
   */
  experimental?: boolean;
}

/**
 * Stable identifiers of the opt-in, paid third-party vendor adapters.
 *
 * These adapters are only ever exercised against mocks today, so they are kept
 * out of the default provider surface ({@link resolveProvider},
 * {@link listAllProviders}). They live under `providers/experimental/` and are
 * enabled explicitly with {@link experimentalProviders}.
 */
export const EXPERIMENTAL_PROVIDER_IDS = ['firecrawl', 'crawl4ai', 'browser-use'] as const;

/** One of the {@link EXPERIMENTAL_PROVIDER_IDS}. */
export type ExperimentalProviderId = (typeof EXPERIMENTAL_PROVIDER_IDS)[number];

/**
 * The default provider surface, in selection order: the always-available
 * built-in Playwright crawler plus the local `reach` capability layer. The paid
 * vendor adapters are deliberately absent, so default routing can never reach
 * them.
 */
function buildDefaultProviders(): CrawlProvider[] {
  return [createBuiltinProvider(), createReachProvider()];
}

/** Instantiate the opt-in vendor adapters (never part of the default set). */
function buildExperimentalProviders(settings: ProviderSettings): CrawlProvider[] {
  return [
    createFirecrawlProvider(settings),
    createCrawl4aiProvider(settings),
    createBrowserUseProvider(settings),
  ];
}

/**
 * Opt in to the paid-vendor adapters (`firecrawl`, `crawl4ai`, `browser-use`).
 *
 * These adapters target paid third-party services and are only verified against
 * mocks, so they are excluded from {@link resolveProvider} and from the default
 * provider surface. Callers must opt in explicitly and instantiate them here.
 *
 * Returns the default set (`builtin` + `reach`) when `enabled` is `false`, and
 * the full set (the three vendors followed by the default providers) when
 * `enabled` is `true`. Settings are read from the environment, exactly as the
 * default surface reads them.
 */
export async function experimentalProviders(enabled: boolean): Promise<CrawlProvider[]> {
  const defaults = buildDefaultProviders();
  if (!enabled) return defaults;
  return [...buildExperimentalProviders(readSettings()), ...defaults];
}

/**
 * List the providers reported by the historical `/providers` and `/health`
 * payloads: the built-in crawler plus the three opt-in vendor adapters, in a
 * stable order.
 *
 * The vendor adapters are still listed so they remain discoverable, but they
 * are flagged `experimental: true` and reported `available: false` — they are
 * not usable backends until {@link experimentalProviders} opts them in.
 *
 * The `reach` capability layer is fully registered — {@link resolveProvider}
 * can select it by name and {@link listAllProviders} includes it — but it is
 * deliberately omitted here so the long-standing payloads (and their
 * consumers) keep their exact shape. The `/providers` and `/health` routes
 * surface `reach` separately via `reachProviderSummary()`.
 */
export function listProviders(settings: ProviderSettings = readSettings()): ProviderSummary[] {
  const experimental: ProviderSummary[] = buildExperimentalProviders(settings).map((provider) => ({
    name: provider.name,
    available: false,
    experimental: true,
  }));

  const defaults: ProviderSummary[] = buildDefaultProviders()
    .filter((provider) => provider.name !== REACH_PROVIDER_NAME)
    .map((provider) => ({
      name: provider.name,
      available: provider.available(),
    }));

  return [...experimental, ...defaults];
}

/** Every registered default provider — including the `reach` capability layer. */
export function listAllProviders(settings: ProviderSettings = readSettings()): ProviderSummary[] {
  return buildDefaultProviders().map((provider) => ({
    name: provider.name,
    available: provider.available(),
  }));
}

/**
 * Resolve the provider to use for a request.
 *
 * Only the default surface is considered — the built-in Playwright crawler and
 * the `reach` capability layer. The paid vendor adapters can **never** be
 * selected here, not even when their environment keys are set; opt them in
 * explicitly with {@link experimentalProviders}.
 *
 * 1. The `preferred` provider by name, when it is a default provider **and** is
 *    available.
 * 2. Otherwise the first available default provider in order (`builtin` →
 *    `reach`).
 * 3. Otherwise the always-available built-in Playwright provider.
 */
export function resolveProvider(
  preferred?: string,
  settings: ProviderSettings = readSettings(),
): CrawlProvider {
  const providers = buildDefaultProviders();
  const builtin = providers.find((provider) => provider.name === BUILTIN_PROVIDER_NAME);
  if (!builtin) {
    // Defensive: buildDefaultProviders always includes builtin, so unreachable.
    return createBuiltinProvider();
  }

  const wanted = preferred?.trim().toLowerCase();
  if (wanted) {
    const match = providers.find((provider) => provider.name === wanted);
    if (match && match.available()) return match;
  }

  for (const provider of providers) {
    if (provider.available()) return provider;
  }

  return builtin;
}

export { BUILTIN_PROVIDER_NAME, createBuiltinProvider } from './builtin.js';
export {
  BROWSER_USE_PROVIDER_NAME,
  createBrowserUseProvider,
  parseBrowserUseResult,
} from './experimental/index.js';
export type { BrowserUseOptions } from './experimental/index.js';
export {
  CRAWL4AI_PROVIDER_NAME,
  createCrawl4aiProvider,
  mapCrawl4aiItem,
} from './experimental/index.js';
export type { Crawl4aiOptions } from './experimental/index.js';
export {
  FIRECRAWL_PROVIDER_NAME,
  createFirecrawlProvider,
  mapFirecrawlDocument,
} from './experimental/index.js';
export type { FirecrawlOptions } from './experimental/index.js';
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
