/**
 * Sign-in + pairing routes.
 *
 * The extension opens a browser tab so the user can sign in with Google. When
 * the redirect comes back we mint a **stateless** session token and stash it on
 * the pairing row keyed by the code the extension generated up front. The
 * extension then polls `/auth/pair/claim` and picks up the token exactly once.
 */
import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AppContext } from '../config.js';
import { signSession, verifySession, SESSION_TTL_MS } from '../crypto.js';
import {
  claimPairing,
  createPairing,
  insertSession,
  readyPairing,
  upsertUser,
  type UserRow,
} from '../db.js';
import { beginAuth, exchangeCode, fetchGoogleProfile, OAuthError } from '../oauth.js';

/** The browser tab the user lands on after a successful redirect. */
export function successHtml(message: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Diggy</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e8eaed;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.card{background:#1b1e24;padding:32px 40px;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.4);text-align:center;font-size:18px}</style>
</head><body><div class="card">${message}</div></body></html>`;
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || undefined;
}

/** Resolve the signed-in user for a request, or `undefined` when unauthenticated. */
export function userFromRequest(ctx: AppContext, request: FastifyRequest): UserRow | undefined {
  const token = bearerToken(request);
  if (!token) return undefined;
  const verified = verifySession(token, ctx.config.sessionSecret);
  if (!verified) return undefined;
  return ctx.db.prepare<[string], UserRow>('SELECT * FROM users WHERE id = ?').get(verified.userId);
}

/**
 * Fastify pre-handler guard: send a 401 and return `undefined` when the request
 * carries no valid session, otherwise return the user.
 */
export function requireUser(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): UserRow | undefined {
  const user = userFromRequest(ctx, request);
  if (!user) {
    reply.code(401).send({ error: 'unauthorized', message: 'A valid Bearer token is required.' });
    return undefined;
  }
  return user;
}

interface PairStartBody {
  code?: unknown;
}

interface PairStartQuery {
  pair?: string;
  ext?: string;
}

interface CallbackQuery {
  code?: string;
  state?: string;
}

interface ClaimQuery {
  code?: string;
}

/**
 * Encode the pairing code (+ optional extension id) into the OAuth `state` so
 * we can tie the callback back to the tab that started it.
 */
function encodeState(pair: string, ext?: string): string {
  return Buffer.from(JSON.stringify({ pair, ext }), 'utf8').toString('base64url');
}

function decodeState(state: string | undefined): { pair?: string; ext?: string } {
  if (!state) return {};
  try {
    const parsed = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as {
      pair?: string;
      ext?: string;
    };
    return parsed;
  } catch {
    return {};
  }
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const redirectUri = `${ctx.config.publicUrl}/auth/google/callback`;

  // 1. The extension registers the code it generated.
  app.post<{ Body: PairStartBody }>('/auth/pair/start', async (request, reply) => {
    const code = request.body?.code;
    if (typeof code !== 'string' || !code.trim()) {
      reply.code(400);
      return { error: 'invalid_request', message: 'Body must include a non-empty "code".' };
    }
    createPairing(ctx.db, code.trim());
    return { ok: true, code: code.trim() };
  });

  // 2. Kick off Google sign-in. `state` carries the pairing code.
  app.get<{ Querystring: PairStartQuery }>('/auth/google/start', async (request, reply) => {
    if (!ctx.config.providers.google.clientId || !ctx.config.providers.google.clientSecret) {
      reply.code(400);
      return {
        error: 'not_configured',
        message:
          'Google sign-in is not configured on the server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
      };
    }
    const pair = typeof request.query.pair === 'string' ? request.query.pair.trim() : '';
    if (!pair) {
      reply.code(400);
      return { error: 'invalid_request', message: 'Query parameter "pair" is required.' };
    }
    try {
      const url = beginAuth('google', redirectUri, encodeState(pair, request.query.ext));
      return reply.redirect(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(error instanceof OAuthError ? 400 : 500);
      return { error: 'oauth_start_failed', message };
    }
  });

  // 3. Google redirects back here: exchange the code, sign the user in and
  //    hand the session token to the waiting pairing.
  app.get<{ Querystring: CallbackQuery }>('/auth/google/callback', async (request, reply) => {
    const code = typeof request.query.code === 'string' ? request.query.code : '';
    if (!code) {
      reply.code(400);
      return { error: 'invalid_request', message: 'Missing "code".' };
    }
    try {
      const tokens = await exchangeCode('google', code, redirectUri);
      const profile = await fetchGoogleProfile(tokens.accessToken);
      if (!profile.sub) throw new Error('Google did not return a subject id');

      const user = upsertUser(ctx.db, {
        id: randomUUID(),
        googleSub: profile.sub,
        email: profile.email ?? tokens.accountLabel ?? null,
        name: profile.name ?? null,
        picture: profile.picture ?? null,
      });

      const sessionToken = signSession(user.id, SESSION_TTL_MS, ctx.config.sessionSecret);
      const now = Date.now();
      insertSession(ctx.db, {
        token: sessionToken,
        user_id: user.id,
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
      });

      const { pair } = decodeState(request.query.state);
      if (pair) readyPairing(ctx.db, pair, sessionToken, JSON.stringify(user));

      reply.type('text/html; charset=utf-8');
      return successHtml('✅ Signed in — you can close this tab.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(400);
      return { error: 'oauth_callback_failed', message };
    }
  });

  // 4. The extension collects the session token — exactly once.
  app.get<{ Querystring: ClaimQuery }>('/auth/pair/claim', async (request) => {
    const code = typeof request.query.code === 'string' ? request.query.code.trim() : '';
    if (!code) return {};
    const row = claimPairing(ctx.db, code);
    if (!row || !row.session_token || !row.user_json) return {};
    return { token: row.session_token, user: JSON.parse(row.user_json) as UserRow };
  });

  // 5. Who am I?
  app.get('/auth/me', async (request, reply) => {
    const user = requireUser(ctx, request, reply);
    if (!user) return;
    return { user };
  });
}
