import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { inject } from './helpers.js';
import {
  EXPERIMENTAL_PROVIDER_IDS,
  experimentalProviders,
  listProviders,
  resolveProvider,
} from '../src/providers/index.js';

const ENV_KEYS = [
  'FIRECRAWL_API_KEY',
  'FIRECRAWL_API_BASE',
  'CRAWL4AI_URL',
  'BROWSER_USE_URL',
] as const;

const EXPERIMENTAL_NAMES = [...EXPERIMENTAL_PROVIDER_IDS] as readonly string[];

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

  it('falls back to builtin when the preferred provider is not a default provider', () => {
    // The paid vendors are no longer part of the default surface, so naming one
    // (or an unknown id) resolves to the always-available built-in crawler.
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
  it('lists the opt-in vendors as unavailable/experimental and builtin as available', () => {
    const rows = listProviders();
    const byName = Object.fromEntries(rows.map((p) => [p.name, p.available]));
    expect(byName).toEqual({
      firecrawl: false,
      crawl4ai: false,
      'browser-use': false,
      builtin: true,
    });

    // The paid vendors are still listed, but only as experimental (never usable).
    const experimental = rows.filter((p) => p.experimental === true);
    expect(experimental.map((p) => p.name)).toEqual([...EXPERIMENTAL_PROVIDER_IDS]);
    for (const row of experimental) {
      expect(row.available).toBe(false);
    }
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

describe('resolveProvider (with vendor env vars configured)', () => {
  it('never selects firecrawl, even when its API key is present', () => {
    process.env.FIRECRAWL_API_KEY = 'test-key';
    expect(resolveProvider().name).toBe('builtin');
    expect(resolveProvider('firecrawl').name).toBe('builtin');

    // It is still listed, but only as an unavailable/experimental vendor.
    const firecrawl = listProviders().find((p) => p.name === 'firecrawl');
    expect(firecrawl?.available).toBe(false);
    expect(firecrawl?.experimental).toBe(true);
  });

  it('never selects crawl4ai, even when only its URL is present', () => {
    process.env.CRAWL4AI_URL = 'http://127.0.0.1:11235';
    expect(resolveProvider().name).toBe('builtin');
    expect(resolveProvider('crawl4ai').name).toBe('builtin');
  });

  it('never selects browser-use, even when only its URL is present', () => {
    process.env.BROWSER_USE_URL = 'http://127.0.0.1:8000';
    expect(resolveProvider().name).toBe('builtin');
    expect(resolveProvider('browser-use').name).toBe('builtin');
  });

  it('reveals the vendor adapters only through the explicit opt-in', async () => {
    process.env.FIRECRAWL_API_KEY = 'test-key';
    process.env.BROWSER_USE_URL = 'http://127.0.0.1:8000';
    expect(resolveProvider().name).toBe('builtin');

    const optedIn = await experimentalProviders(true);
    expect(optedIn.map((p) => p.name)).toEqual([
      'firecrawl',
      'crawl4ai',
      'browser-use',
      'builtin',
      'reach',
    ]);
  });
});

describe('default provider surface', () => {
  it('never includes an experimental (paid vendor) id', async () => {
    // The default set (opt-in disabled) must not contain any experimental id.
    const defaults = await experimentalProviders(false);
    for (const provider of defaults) {
      expect(EXPERIMENTAL_NAMES).not.toContain(provider.name);
    }
    expect(defaults.map((provider) => provider.name)).toEqual(['builtin', 'reach']);

    // Opting in still surfaces every vendor adapter from its new home.
    const optedIn = await experimentalProviders(true);
    const optedInNames = optedIn.map((provider) => provider.name);
    for (const id of EXPERIMENTAL_PROVIDER_IDS) {
      expect(optedInNames).toContain(id);
    }

    // And default routing can never reach a vendor, even with its key configured.
    process.env.FIRECRAWL_API_KEY = 'test-key';
    expect(resolveProvider().name).toBe('builtin');
  });
});

describe('provider HTTP surface (offline)', () => {
  const app = buildServer();

  afterAll(async () => {
    await app.close();
  });

  it('GET /health lists every provider', async () => {
    const response = await inject(app, { method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      status: string;
      providers: { name: string; available: boolean; experimental?: boolean }[];
    };
    expect(body.status).toBe('ok');
    expect(body.providers.map((p) => p.name)).toEqual([
      'firecrawl',
      'crawl4ai',
      'browser-use',
      'builtin',
    ]);
    expect(body.providers.find((p) => p.name === 'firecrawl')?.experimental).toBe(true);
  });

  it('GET /providers returns the same provider list', async () => {
    const response = await inject(app, { method: 'GET', url: '/providers' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { providers: { name: string; available: boolean }[] };
    expect(body.providers).toEqual(listProviders());
  });

  it('POST /extract still handles inline HTML when a provider is requested', async () => {
    const response = await inject(app, {
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
    const response = await inject(app, { method: 'POST', url: '/crawl', payload: {} });
    expect(response.statusCode).toBe(400);
  });
});
