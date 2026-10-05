import { describe, expect, it } from 'vitest';
import { HostRateLimiter, getCrawlDelayMs, isUrlAllowed } from '../src/robots.js';

const ROBOTS = [
  'User-agent: *',
  'Disallow: /private',
  'Crawl-delay: 2',
  'Sitemap: https://example.com/sitemap.xml',
  '',
  'User-agent: DiggyBot',
  'Disallow: /admin',
  '',
].join('\n');

describe('isUrlAllowed', () => {
  it('allows everything when robots.txt is empty or missing', () => {
    expect(isUrlAllowed('', 'https://example.com/private')).toBe(true);
    expect(isUrlAllowed(null, 'https://example.com/private')).toBe(true);
    expect(isUrlAllowed(undefined, 'https://example.com/private')).toBe(true);
  });

  it('blocks paths disallowed for the wildcard user-agent', () => {
    expect(isUrlAllowed(ROBOTS, 'https://example.com/private/page')).toBe(false);
    expect(isUrlAllowed(ROBOTS, 'https://example.com/public/page')).toBe(true);
  });

  it('respects a user-agent specific group', () => {
    expect(isUrlAllowed(ROBOTS, 'https://example.com/admin/x', 'DiggyBot')).toBe(false);
    expect(isUrlAllowed(ROBOTS, 'https://example.com/public', 'DiggyBot')).toBe(true);
  });
});

describe('getCrawlDelayMs', () => {
  it('converts the declared crawl-delay to milliseconds', () => {
    expect(getCrawlDelayMs(ROBOTS, 'https://example.com/', '*')).toBe(2000);
  });

  it('returns undefined when no crawl-delay is declared', () => {
    expect(getCrawlDelayMs('User-agent: *\nDisallow:', 'https://example.com/')).toBeUndefined();
    expect(getCrawlDelayMs('', 'https://example.com/')).toBeUndefined();
  });
});

describe('HostRateLimiter', () => {
  it('enforces a minimum interval between requests to the same host', async () => {
    const limiter = new HostRateLimiter(60);
    const start = Date.now();
    await limiter.wait('example.com');
    await limiter.wait('example.com');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45);
  });

  it('does not delay the first request to a fresh host', async () => {
    const limiter = new HostRateLimiter(1000);
    const start = Date.now();
    await limiter.wait('fresh.example.com');
    expect(Date.now() - start).toBeLessThan(500);
  });
});
