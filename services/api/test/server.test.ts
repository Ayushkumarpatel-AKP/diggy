import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createContext, type AppContext } from '../src/config.js';
import { SESSION_TTL_MS, signSession } from '../src/crypto.js';
import { readyPairing, upsertUser, type UserRow } from '../src/db.js';
import { buildServer } from '../src/server.js';

/** Isolated in-memory context with no OAuth apps configured. */
const ctx: AppContext = createContext({ dbPath: ':memory:', env: {} });
const app = buildServer({ context: ctx });

let user: UserRow;
let token: string;

beforeAll(() => {
  user = upsertUser(ctx.db, {
    id: randomUUID(),
    googleSub: 'google-sub-123',
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    picture: null,
  });
  token = signSession(user.id, SESSION_TTL_MS, ctx.config.sessionSecret);
});

afterAll(async () => {
  await app.close();
});

function authHeader(value: string): { authorization: string } {
  return { authorization: `Bearer ${value}` };
}

describe('GET /health', () => {
  it('reports the service identity', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', service: '@diggy/api' });
  });
});

describe('GET /plugins', () => {
  it('returns 401 without a Bearer token', async () => {
    const response = await app.inject({ method: 'GET', url: '/plugins' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('returns the plugin registry for an authenticated user', async () => {
    const response = await app.inject({ method: 'GET', url: '/plugins', headers: authHeader(token) });
    expect(response.statusCode).toBe(200);
    const plugins = response.json() as { id: string; auth: string; connected: boolean }[];
    expect(plugins.map((plugin) => plugin.id)).toEqual(['google', 'notion', 'github', 'youtube']);

    const youtube = plugins.find((plugin) => plugin.id === 'youtube');
    expect(youtube).toMatchObject({ auth: 'none', connected: false });

    const google = plugins.find((plugin) => plugin.id === 'google');
    expect(google).toMatchObject({ auth: 'oauth2', connected: false });
  });
});

describe('GET /auth/me', () => {
  it('returns the signed-in user', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/me', headers: authHeader(token) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { id: user.id, email: 'ada@example.com' } });
  });

  it('rejects a request without a token', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /auth/google/start', () => {
  it('returns a clear JSON error when Google is not configured', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/google/start?pair=abc' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'not_configured' });
  });
});

describe('pairing flow', () => {
  it('registers, claims exactly once, then returns empty', async () => {
    const code = `pair-${randomUUID()}`;

    const start = await app.inject({ method: 'POST', url: '/auth/pair/start', payload: { code } });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ ok: true, code });

    // Before the OAuth callback marks it ready there is nothing to claim.
    const early = await app.inject({ method: 'GET', url: `/auth/pair/claim?code=${code}` });
    expect(early.json()).toEqual({});

    // The Google callback would do this; simulate it here (offline).
    readyPairing(ctx.db, code, token, JSON.stringify(user));

    const first = await app.inject({ method: 'GET', url: `/auth/pair/claim?code=${code}` });
    expect(first.statusCode).toBe(200);
    const claimed = first.json() as { token?: string; user?: UserRow };
    expect(claimed.token).toBe(token);
    expect(claimed.user?.id).toBe(user.id);

    const second = await app.inject({ method: 'GET', url: `/auth/pair/claim?code=${code}` });
    expect(second.json()).toEqual({});
  });

  it('rejects /auth/pair/start without a code', async () => {
    const response = await app.inject({ method: 'POST', url: '/auth/pair/start', payload: {} });
    expect(response.statusCode).toBe(400);
  });
});

describe('actions', () => {
  it('rejects an authenticated action for a provider the user has not connected', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/actions/google/gmail.list',
      headers: authHeader(token),
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'not_connected' });
  });

  it('404s an unknown action', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/actions/github/nope',
      headers: authHeader(token),
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'unknown_action' });
  });
});
