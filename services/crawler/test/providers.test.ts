import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { listProviders, resolveProvider } from '../src/providers/index.js';

const ENV_KEYS = [
  'FIRECRAWL_API_KEY',
  'FIRECRAWL_API_BASE',
  'CRAWL4AI_URL',
  'BROWSER_USE_URL',
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('resolveProvider (no env vars)', () => {
  it('always resolves to the built-in Playwright provider', () => {
    expect(resolveProvider().name).toBe('builtin');
    expect(resolveProvider(undefined).available()).toBe(true);
  });

  it('falls back to builtin when the preferred provider is unavailable', () => {
    expect(resolveProvider('firecrawl').name).toBe('builtin');
    expect(resolveProvider('crawl4ai').name).toBe('builtin');
    expect(resolveProvider('browser-use').name).toBe('builtin');
    expect(resolveProvider('nope-not-real').name).toBe('builtin');
  });

  it('resolves the builtin provider explicitly', () => {
    const provider = resolveProvider('builtin');
    expect(provider.name).toBe('builtin');
    expect(provider.available()).toBe(true);
  });

  it('exposes a crawl() implementation on the builtin provider', () => {
    expect(typeof resolveProvider().crawl).toBe('function');
    expect(typeof resolveProvider().extract).toBe('function');
  });
});

describe('listProviders (no env vars)', () => {
  it('marks network providers unavailable and the builtin provider available', () => {
    const byName = Object.fromEntries(listProviders().map((p) => [p.name, p.available]));
    expect(byName).toEqual({
      firecrawl: false,
      crawl4ai: false,
      'browser-use': false,
      builtin: true,
    });
  });

  it('reports providers in a stable preference order', () => {
    expect(listProviders().map((p) => p.name)).toEqual([
      'firecrawl',
      'crawl4ai',
      'browser-use',
      'builtin',
    ]);
  });
});

describe('resolveProvider (with env vars configured)', () => {
  it('prefers firecrawl when its API key is present', () => {
    process.env.FIRECRAWL_API_KEY = 'test-key';
    expect(resolveProvider().name).toBe('firecrawl');
    expect(resolveProvider('firecrawl').name).toBe('firecrawl');
    expect(listProviders().find((p) => p.name === 'firecrawl')?.available).toBe(true);
  });

  it('prefers crawl4ai when only its URL is present', () => {
    process.env.CRAWL4AI_URL = 'http://127.0.0.1:11235';
    expect(resolveProvider().name).toBe('crawl4ai');
  });

  it('prefers browser-use when only its URL is present', () => {
    process.env.BROWSER_USE_URL = 'http://127.0.0.1:8000';
    expect(resolveProvider().name).toBe('browser-use');
  });

  it('honours an explicit preference over the default order', () => {
    process.env.FIRECRAWL_API_KEY = 'test-key';
    process.env.BROWSER_USE_URL = 'http://127.0.0.1:8000';
    expect(resolveProvider('browser-use').name).toBe('browser-use');
    expect(resolveProvider().name).toBe('firecrawl');
  });
});

describe('provider HTTP surface (offline)', () => {
  const app = buildServer();

  afterAll(async () => {
    await app.close();
  });

  it('GET /health lists every provider', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      status: string;
      providers: { name: string; available: boolean }[];
    };
    expect(body.status).toBe('ok');
    expect(body.providers.map((p) => p.name)).toEqual([
      'firecrawl',
      'crawl4ai',
      'browser-use',
      'builtin',
    ]);
  });

  it('GET /providers returns the same provider list', async () => {
    const response = await app.inject({ method: 'GET', url: '/providers' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { providers: { name: string; available: boolean }[] };
    expect(body.providers).toEqual(listProviders());
  });

  it('POST /extract still handles inline HTML when a provider is requested', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/extract',
      payload: {
        html: '<html><body><article><p>Hello <b>providers</b> from inline HTML.</p></article></body></html>',
        provider: 'firecrawl',
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { title: string; markdown: string };
    expect(body.markdown).toContain('Hello');
    expect(body.markdown).toContain('**providers**');
  });

  it('POST /crawl rejects a request without a url', async () => {
    const response = await app.inject({ method: 'POST', url: '/crawl', payload: {} });
    expect(response.statusCode).toBe(400);
  });
});
