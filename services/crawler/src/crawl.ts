import { chromium, type Browser, type LaunchOptions } from 'playwright-core';
import { extractFromHtml } from './extract.js';
import {
  DEFAULT_USER_AGENT,
  HostRateLimiter,
  getCrawlDelayMs,
  hostKeyFor,
  isUrlAllowed,
} from './robots.js';

export interface CrawlOptions {
  /** Seed URL to start the breadth-first crawl from. */
  url: string;
  /** How many link hops to follow from the seed (default 1). */
  depth?: number;
  /** Hard cap on the number of pages that will be fetched (default 20). */
  maxPages?: number;
  /** Only follow links on the seed's origin (default true). */
  sameOrigin?: boolean;
  /** Per-host minimum interval between requests, in ms (default 1000). */
  minIntervalMs?: number;
  /** Per-navigation timeout, in ms (default 30000). */
  timeoutMs?: number;
  /** User-Agent sent to the browser and used for robots.txt matching. */
  userAgent?: string;
}

export interface CrawlPage {
  url: string;
  title: string;
  markdown: string;
}

interface QueueItem {
  url: string;
  depth: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Launch a real browser. Prefers the system-installed Google Chrome, then Edge,
 * and finally a Playwright-managed Chromium build. Throws a single, actionable
 * error when no browser is available so callers can degrade gracefully.
 */
export async function launchBrowser(): Promise<Browser> {
  const attempts: Array<{ label: string; options: LaunchOptions }> = [
    { label: "channel 'chrome'", options: { channel: 'chrome' } },
    { label: "channel 'msedge'", options: { channel: 'msedge' } },
    { label: 'managed chromium', options: {} },
  ];

  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      return await chromium.launch({ ...attempt.options, headless: true });
    } catch (error) {
      errors.push(`${attempt.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(
    '@diggy/crawler could not start a browser. Install Google Chrome, or run ' +
      '`npx playwright install chromium`. Attempts -> ' +
      errors.join(' | '),
  );
}

/**
 * Fetch a single page with a real browser and return its rendered HTML.
 * Used by `POST /extract` when only a URL is provided.
 */
export async function fetchPageHtml(
  url: string,
  options: { userAgent?: string; timeoutMs?: number; waitUntil?: 'load' | 'domcontentloaded' } = {},
): Promise<string> {
  const browser = await launchBrowser();
  const context = await browser.newContext({
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
  });
  try {
    const page = await context.newPage();
    try {
      await page.goto(url, {
        waitUntil: options.waitUntil ?? 'load',
        timeout: options.timeoutMs ?? 30000,
      });
      return await page.content();
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

async function fetchRobotsTxt(
  origin: string,
  userAgent: string,
  timeoutMs: number,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${origin}/robots.txt`, {
      headers: { 'user-agent': userAgent, accept: 'text/plain,*/*' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) return null; // No robots.txt (404/500/etc) → allow all.
    return await response.text();
  } catch {
    // Network failure or timeout while fetching robots.txt → fail open.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Breadth-first crawl with Playwright. Respects robots.txt, enforces `maxPages`
 * and a per-host rate limit, and returns readable Markdown for every page.
 */
export async function crawl(options: CrawlOptions): Promise<CrawlPage[]> {
  const startUrl = normalizeUrl(options.url);
  if (!startUrl) {
    throw new Error(`Invalid crawl url: ${options.url}`);
  }

  const maxDepth = Math.max(0, options.depth ?? 1);
  const maxPages = Math.max(1, options.maxPages ?? 20);
  const sameOrigin = options.sameOrigin ?? true;
  const minIntervalMs = options.minIntervalMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 30000;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const startOrigin = originOf(startUrl);

  const browser = await launchBrowser();
  const results: CrawlPage[] = [];

  try {
    const context = await browser.newContext({ userAgent });
    const limiter = new HostRateLimiter(minIntervalMs);
    const robotsCache = new Map<string, string | null>();
    const visited = new Set<string>();
    const queue: QueueItem[] = [{ url: startUrl, depth: 0 }];

    while (queue.length > 0 && results.length < maxPages) {
      const item = queue.shift();
      if (!item) break;

      const current = item.url;
      if (visited.has(current)) continue;
      visited.add(current);

      const origin = originOf(current);
      if (!origin) continue;
      if (sameOrigin && startOrigin && origin !== startOrigin) continue;

      if (!robotsCache.has(origin)) {
        robotsCache.set(origin, await fetchRobotsTxt(origin, userAgent, timeoutMs));
      }
      const robotsTxt = robotsCache.get(origin) ?? null;
      if (!isUrlAllowed(robotsTxt, current, userAgent)) continue;

      // Enforce the per-host floor, then add any explicit crawl-delay that is
      // larger than it so we stay polite to sites that ask for a slower rate.
      await limiter.wait(hostKeyFor(current));
      const declaredDelay = getCrawlDelayMs(robotsTxt, current, userAgent);
      if (declaredDelay && declaredDelay > minIntervalMs) {
        await delay(declaredDelay - minIntervalMs);
      }

      const page = await context.newPage();
      try {
        await page.goto(current, { waitUntil: 'load', timeout: timeoutMs });
        // Best-effort settle for late network activity / lazy content.
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => undefined);

        const html = await page.content();
        const extracted = extractFromHtml(html, current);
        results.push({ url: current, title: extracted.title, markdown: extracted.markdown });

        if (item.depth < maxDepth) {
          const hrefs: string[] = await page.$$eval('a[href]', (anchors) =>
            anchors.map((anchor) => (anchor as HTMLAnchorElement).href).filter(Boolean),
          );
          for (const href of hrefs) {
            const next = normalizeUrl(href);
            if (!next || visited.has(next) || !isHttpUrl(next)) continue;
            if (sameOrigin && startOrigin && originOf(next) !== startOrigin) continue;
            queue.push({ url: next, depth: item.depth + 1 });
          }
        }
      } catch {
        // Skip pages that fail to load and keep crawling the rest.
      } finally {
        await page.close().catch(() => undefined);
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  return results;
}
