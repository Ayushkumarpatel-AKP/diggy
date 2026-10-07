/**
 * Security tests for `@diggy/api`: per-install token, Host validation, Origin
 * validation and JSON content-type enforcement. Offline — all driven through
 * `fastify.inject`, no sockets.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { createContext } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { TEST_HOST, TEST_TOKEN, serviceHeaders } from './helpers.js';

const app = buildServer({ context: createContext({ dbPath: ':memory:', env: {} }) });

afterAll(async () => {
  await app.close();
});

/** A URL that needs no user session so only the service guard is exercised. */
const OPEN_URL = '/favicon?url=https%3A%2F%2Fexample.com%2F';

describe('per-install token', () => {
  it('rejects a missing token with 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/plugins', headers: { host: TEST_HOST } });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects a wrong token with 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/plugins',
      headers: { host: TEST_HOST, 'x-diggy-token': 'not-the-token' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
  });

  it('accepts the correct token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: OPEN_URL,
      headers: serviceHeaders(),
    });
    expect(response.statusCode).toBe(200);
  });

  it('exempts GET /health from the token', async () => {
    const response = await app.inject({ method: 'GET', url: '/health', headers: { host: TEST_HOST } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('still requires the token on other GETs', async () => {
    const response = await app.inject({ method: 'GET', url: '/plugins', headers: { host: TEST_HOST } });
    expect(response.statusCode).toBe(401);
  });
});

describe('Host header validation', () => {
  it('rejects a foreign Host with 403', async () => {
    const response = await app.inject({ method: 'GET', url: '/health', headers: { host: 'evil.com' } });
    expect(response.statusCode).toBe(403);
  });

  it('rejects loopback on the wrong port with 403', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { host: '127.0.0.1:9999' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects a bare hostname without the service port', async () => {
    const response = await app.inject({ method: 'GET', url: '/health', headers: { host: 'localhost' } });
    expect(response.statusCode).toBe(403);
  });
});

describe('Origin validation', () => {
  it('rejects a foreign Origin with 403', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { host: TEST_HOST, origin: 'https://evil.com' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('rejects a localhost web origin with 403', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { host: TEST_HOST, origin: 'http://localhost:3000' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('allows a chrome-extension Origin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { host: TEST_HOST, origin: 'chrome-extension://abcdefghijklmnop' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('allows a missing Origin (non-browser client)', async () => {
    const response = await app.inject({ method: 'GET', url: '/health', headers: { host: TEST_HOST } });
    expect(response.statusCode).toBe(200);
  });
});

describe('content-type validation', () => {
  it('rejects a text/plain POST body with 415', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/pair/start',
      headers: serviceHeaders({ 'content-type': 'text/plain' }),
      payload: 'code=abc',
    });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({ error: 'unsupported_media_type' });
  });

  it('accepts an application/json POST body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/pair/start',
      headers: serviceHeaders(),
      payload: { code: 'pair-abc' },
    });
    expect(response.statusCode).toBe(200);
  });
});
