import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import {
  decodeDuckDuckGoUrl,
  isNetworkDisabled,
  parseDuckDuckGoHtml,
  searchWeb,
} from '../src/search.js';

const FIXTURE = `<!DOCTYPE html>
<html>
  <body>
    <div class="serp__results">
      <div class="result results_links results_links_deep web-result">
        <div class="links_main links_deep result__body">
          <h2 class="result__title">
            <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&#x26;rut=abc">First Result</a>
          </h2>
          <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone">First   snippet for the first hit.</a>
        </div>
      </div>
      <div class="result results_links results_links_deep web-result">
        <div class="links_main links_deep result__body">
          <h2 class="result__title">
            <a rel="nofollow" class="result__a" href="https://example.com/two">Second Result</a>
          </h2>
          <a class="result__snippet" href="https://example.com/two">Second snippet.</a>
        </div>
      </div>
      <div class="result result--ad">
        <a class="result__a" href="https://ads.example.com/promo">Sponsored</a>
      </div>
    </div>
  </body>
</html>`;

describe('parseDuckDuckGoHtml', () => {
  it('extracts title, url and snippet from result markup', () => {
    const results = parseDuckDuckGoHtml(FIXTURE);
    expect(results).toEqual([
      {
        title: 'First Result',
        url: 'https://example.com/one',
        snippet: 'First snippet for the first hit.',
      },
      { title: 'Second Result', url: 'https://example.com/two', snippet: 'Second snippet.' },
      { title: 'Sponsored', url: 'https://ads.example.com/promo', snippet: '' },
    ]);
  });

  it('caps the number of results', () => {
    expect(parseDuckDuckGoHtml(FIXTURE, { maxResults: 1 })).toHaveLength(1);
  });

  it('returns an empty list for markup without results', () => {
    expect(parseDuckDuckGoHtml('<html><body><p>nothing here</p></body></html>')).toEqual([]);
  });
});

describe('decodeDuckDuckGoUrl', () => {
  it('unwraps the uddg redirect parameter', () => {
    expect(
      decodeDuckDuckGoUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&rut=abc'),
    ).toBe('https://example.com/one');
  });

  it('passes through absolute urls unchanged', () => {
    expect(decodeDuckDuckGoUrl('https://example.com/two')).toBe('https://example.com/two');
  });
});

describe('searchWeb (offline guard)', () => {
  it('reports the network as disabled under the test runner', () => {
    expect(isNetworkDisabled()).toBe(true);
  });

  it('returns no results without performing a request when offline', async () => {
    let called = false;
    const results = await searchWeb('diggy', {
      fetchImpl: () => {
        called = true;
        return Promise.resolve(new Response('should not be called', { status: 500 }));
      },
    });
    expect(results).toEqual([]);
    expect(called).toBe(false);
  });

  it('builds and parses a request against an injected fetch (no socket)', async () => {
    let requestedUrl = '';
    const results = await searchWeb('diggy research', {
      allowNetwork: true,
      fetchImpl: (input) => {
        requestedUrl = String(input);
        return Promise.resolve(new Response(FIXTURE, { status: 200 }));
      },
    });
    expect(requestedUrl).toContain('q=diggy%20research');
    expect(results).toHaveLength(3);
    expect(results[0]?.url).toBe('https://example.com/one');
  });
});

describe('GET /search (offline)', () => {
  const app = buildServer();

  afterAll(async () => {
    await app.close();
  });

  it('returns an offline, empty result set without hitting the network', async () => {
    const response = await app.inject({ method: 'GET', url: '/search?q=diggy' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { query: string; results: unknown[]; offline: boolean };
    expect(body.query).toBe('diggy');
    expect(body.results).toEqual([]);
    expect(body.offline).toBe(true);
  });

  it('rejects a request without a query', async () => {
    const response = await app.inject({ method: 'GET', url: '/search' });
    expect(response.statusCode).toBe(400);
  });
});
