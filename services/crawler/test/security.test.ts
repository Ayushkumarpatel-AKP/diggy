/**
 * Security tests for `@diggy/crawler`: token/Host/Origin/content-type guards,
 * the SSRF guard on `/extract` and `/crawl`, the fetch caps and the Jina Reader
 * gate. Everything is offline (`fastify.inject` / injected fetch).
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { isJinaEligible, isJinaEnabled, isSensitiveParam } from '../src/jina.js';
import { readWithReach } from '../src/providers/reach.js';
import { buildServer } from '../src/server.js';
import { BlockedUrlError, checkUrl, isBlockedIp, safeFetchText } from '../src/ssrf.js';
import { TEST_HOST, TEST_TOKEN, serviceHeaders } from './helpers.js';

const app = buildServer();

afterAll(async () => {
  await app.close();
});

describe('per-install token', () => {
  it('rejects a missing token with 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/providers', headers: { host: TEST_HOST } });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects a wrong token with 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/providers',
      headers: { host: TEST_HOST, 'x-diggy-token': 'nope' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts the correct token', async () => {
    const response = await app.inject({ method: 'GET', url: '/providers', headers: serviceHeaders() });
    expect(response.statusCode).toBe(200);
  });

  it('exempts GET /health from the token', async () => {
    const response = await app.inject({ method: 'GET', url: '/health', headers: { host: TEST_HOST } });
    expect(response.statusCode).toBe(200);
  });
});

describe('Host header validation', () => {
  it('rejects a foreign Host with 403', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/providers',
      headers: { host: 'evil.com', 'x-diggy-token': TEST_TOKEN },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects loopback on the wrong port with 403', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/providers',
      headers: { host: '127.0.0.1:1234', 'x-diggy-token': TEST_TOKEN },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('Origin validation', () => {
  it('rejects a foreign Origin with 403', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/providers',
      headers: serviceHeaders({ origin: 'https://evil.com' }),
    });
    expect(response.statusCode).toBe(403);
  });

  it('allows a chrome-extension Origin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/providers',
      headers: serviceHeaders({ origin: 'chrome-extension://abc' }),
    });
    expect(response.statusCode).toBe(200);
  });

  it('allows a missing Origin', async () => {
    const response = await app.inject({ method: 'GET', url: '/providers', headers: serviceHeaders() });
    expect(response.statusCode).toBe(200);
  });
});

describe('content-type validation', () => {
  it('rejects a text/plain POST body with 415', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/extract',
      headers: serviceHeaders({ 'content-type': 'text/plain' }),
      payload: 'url=http://10.0.0.1',
    });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({ error: 'unsupported_media_type' });
  });

  it('lets an application/json POST body through the guard', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/extract',
      headers: serviceHeaders(),
      payload: {},
    });
    // Reaches the handler, which 400s for a missing url/html — not a 415.
    expect(response.statusCode).toBe(400);
  });
});

describe('SSRF guard on routes', () => {
  const blocked = [
    'http://127.0.0.1',
    'http://127.0.0.1:17323',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1',
    'file:///etc/passwd',
  ];

  for (const url of blocked) {
    it(`blocks POST /extract ${url}`, async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/extract',
        headers: serviceHeaders(),
        payload: { url },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'blocked_url' });
    });
  }

  it('blocks POST /crawl for a private address', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/crawl',
      headers: serviceHeaders(),
      payload: { url: 'http://169.254.169.254/' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'blocked_url' });
  });
});

describe('SSRF classification', () => {
  it('blocks loopback, private, link-local, CGNAT, unique-local and metadata', () => {
    const blocked = [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.5.5',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00:ec2::254',
      'fe80::1',
    ];
    for (const ip of blocked) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('allows public addresses', () => {
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    expect(isBlockedIp('2001:4860:4860::8888')).toBe(false);
  });

  it('checkUrl rejects non-http schemes', async () => {
    expect(await checkUrl('file:///etc/passwd')).toMatchObject({ ok: false });
    expect(await checkUrl('ftp://example.com')).toMatchObject({ ok: false });
  });

  it('checkUrl rejects private literals and allows public ones', async () => {
    expect(await checkUrl('http://127.0.0.1')).toMatchObject({ ok: false });
    expect(await checkUrl('http://169.254.169.254')).toMatchObject({ ok: false });
    expect(await checkUrl('http://[::1]')).toMatchObject({ ok: false });
    expect(await checkUrl('http://8.8.8.8')).toMatchObject({ ok: true });
  });
});

describe('safeFetchText caps', () => {
  it('never calls fetch for a blocked URL', async () => {
    let called = false;
    const fetchImpl = (() => {
      called = true;
      return Promise.resolve(new Response(''));
    }) as unknown as typeof fetch;

    await expect(safeFetchText('http://10.0.0.1/x', { fetchImpl })).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
    expect(called).toBe(false);
  });

  it('caps the number of redirects', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: 'http://8.8.8.8/again' } }),
      )) as unknown as typeof fetch;

    await expect(
      safeFetchText('http://8.8.8.8/start', { fetchImpl, maxRedirects: 2 }),
    ).rejects.toThrow(/too_many_redirects/);
  });

  it('re-validates each redirect hop', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } }),
      )) as unknown as typeof fetch;

    await expect(safeFetchText('http://8.8.8.8/start', { fetchImpl })).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
  });

  it('caps the response size', async () => {
    const fetchImpl = (() =>
      Promise.resolve(new Response('x'.repeat(2048), { status: 200 }))) as unknown as typeof fetch;

    await expect(
      safeFetchText('http://8.8.8.8/big', { fetchImpl, maxBytes: 64 }),
    ).rejects.toThrow(/response_too_large/);
  });
});

describe('Jina Reader gate', () => {
  const saved = process.env.DIGGY_JINA;

  afterEach(() => {
    if (saved === undefined) delete process.env.DIGGY_JINA;
    else process.env.DIGGY_JINA = saved;
  });

  it('is off by default', () => {
    delete process.env.DIGGY_JINA;
    expect(isJinaEnabled()).toBe(false);
  });

  it('does not read anything while off', async () => {
    delete process.env.DIGGY_JINA;
    let called = false;
    const result = await readWithReach('https://example.com/', {
      allowNetwork: true,
      fetchImpl: () => {
        called = true;
        return Promise.resolve(new Response('x'));
      },
    });
    expect(result).toBeUndefined();
    expect(called).toBe(false);
  });

  it('refuses a token-bearing URL when enabled', async () => {
    process.env.DIGGY_JINA = '1';
    expect(isJinaEnabled()).toBe(true);

    let called = false;
    const result = await readWithReach('https://example.com/page?token=secret', {
      allowNetwork: true,
      fetchImpl: () => {
        called = true;
        return Promise.resolve(new Response('x'));
      },
    });
    expect(result).toBeUndefined();
    expect(called).toBe(false);
  });

  it('reads a clean public URL when enabled', async () => {
    process.env.DIGGY_JINA = '1';
    const result = await readWithReach('https://example.com/page', {
      allowNetwork: true,
      fetchImpl: () => Promise.resolve(new Response('Title: Hello\n\nbody text', { status: 200 })),
    });
    expect(result?.title).toBe('Hello');
    expect(result?.text).toContain('body text');
  });

  it('classifies unsafe URLs as ineligible', () => {
    expect(isJinaEligible('http://127.0.0.1/').ok).toBe(false);
    expect(isJinaEligible('http://user:pass@example.com/').ok).toBe(false);
    expect(isJinaEligible('https://example.com/?access_token=abc').ok).toBe(false);
    expect(isJinaEligible('https://example.com/?api_key=abc').ok).toBe(false);
    expect(isJinaEligible('https://mine.example.com/x', { ownedSites: ['mine.example.com'] }).ok).toBe(
      false,
    );
    expect(isJinaEligible('file:///etc/passwd').ok).toBe(false);
  });

  it('accepts a plain public URL', () => {
    expect(isJinaEligible('https://example.com/docs', { ownedSites: [] }).ok).toBe(true);
  });

  it('flags token-like query parameter names', () => {
    expect(isSensitiveParam('token')).toBe(true);
    expect(isSensitiveParam('access_token')).toBe(true);
    expect(isSensitiveParam('X-Amz-Signature')).toBe(true);
    expect(isSensitiveParam('page')).toBe(false);
  });
});
