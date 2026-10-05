import robotsParser from 'robots-parser';

/** Default User-Agent used by the crawler when none is supplied. */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; DiggyBot/0.1; +https://github.com/diggy)';

/**
 * Parse a robots.txt body for the given URL. `url` only needs to be a URL whose
 * origin is used to build the canonical robots.txt location.
 */
export function parseRobots(url: string, body: string) {
  return robotsParser(robotsUrlFor(url), body);
}

/** Build the canonical `.../robots.txt` URL for an origin (or any URL). */
export function robotsUrlFor(url: string): string {
  try {
    return new URL('/robots.txt', url).toString();
  } catch {
    return url;
  }
}

/**
 * Returns `true` when `url` may be fetched for `userAgent` according to the
 * supplied robots.txt body. A missing/empty body is treated as "allow all",
 * matching the behaviour of a site that serves no robots.txt.
 */
export function isUrlAllowed(
  robotsTxt: string | null | undefined,
  url: string,
  userAgent: string = '*',
): boolean {
  if (!robotsTxt || !robotsTxt.trim()) return true;
  try {
    const robots = robotsParser(robotsUrlFor(url), robotsTxt);
    return robots.isAllowed(url, userAgent) !== false;
  } catch {
    // A malformed robots.txt should not block the crawl outright.
    return true;
  }
}

/**
 * Crawl-delay declared for `userAgent` in the robots.txt body, in milliseconds.
 * Returns `undefined` when the body does not declare one.
 */
export function getCrawlDelayMs(
  robotsTxt: string | null | undefined,
  url: string,
  userAgent: string = '*',
): number | undefined {
  if (!robotsTxt || !robotsTxt.trim()) return undefined;
  try {
    const robots = robotsParser(robotsUrlFor(url), robotsTxt);
    const seconds = robots.getCrawlDelay(userAgent);
    if (typeof seconds !== 'number' || Number.isNaN(seconds) || seconds <= 0) return undefined;
    return seconds * 1000;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Extract the host key used for per-host rate limiting. */
export function hostKeyFor(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Serializes requests to the same host so that at least `minIntervalMs`
 * elapses between consecutive requests to a given host.
 */
export class HostRateLimiter {
  private readonly minIntervalMs: number;
  private readonly lastRequestAt = new Map<string, number>();
  private readonly chains = new Map<string, Promise<void>>();

  constructor(minIntervalMs = 1000) {
    this.minIntervalMs = Math.max(0, minIntervalMs);
  }

  /** Wait until it is safe to issue the next request to `host`. */
  async wait(host: string): Promise<void> {
    const previous = this.chains.get(host) ?? Promise.resolve();
    const next = previous.then(() => this.handleRequest(host));
    // Keep the chain alive even if a caller rejects elsewhere.
    this.chains.set(
      host,
      next.catch(() => undefined),
    );
    return next;
  }

  private async handleRequest(host: string): Promise<void> {
    const last = this.lastRequestAt.get(host);
    if (typeof last === 'number') {
      const elapsed = Date.now() - last;
      if (elapsed < this.minIntervalMs) {
        await sleep(this.minIntervalMs - elapsed);
      }
    }
    this.lastRequestAt.set(host, Date.now());
  }

  /** Forget the recorded timings (optionally for a single host). */
  reset(host?: string): void {
    if (host === undefined) {
      this.lastRequestAt.clear();
      this.chains.clear();
      return;
    }
    this.lastRequestAt.delete(host);
    this.chains.delete(host);
  }
}
