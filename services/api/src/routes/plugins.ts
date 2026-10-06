/**
 * Plugin connection routes.
 *
 * `GET /plugins` powers the extension's one-click list. Connecting just
 * redirects to the provider and stores the resulting tokens **encrypted** in
 * the database; the extension never sees a client id, secret or raw token.
 */
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../config.js';
import { encryptString, verifySession } from '../crypto.js';
import { deleteConnection, listConnections, upsertConnection } from '../db.js';
import { beginAuth, exchangeCode, OAuthError } from '../oauth.js';
import { getProvider, listProviders } from '../providers.js';
import { requireUser, successHtml } from './auth.js';

interface StartQuery {
  session?: string;
  ext?: string;
}

interface CallbackQuery {
  code?: string;
  state?: string;
}

interface ProviderParams {
  provider: string;
}

function encodeState(session: string, ext?: string): string {
  return Buffer.from(JSON.stringify({ session, ext }), 'utf8').toString('base64url');
}

function decodeState(state: string | undefined): { session?: string; ext?: string } {
  if (!state) return {};
  try {
    return JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as {
      session?: string;
      ext?: string;
    };
  } catch {
    return {};
  }
}

export function registerPluginRoutes(app: FastifyInstance, ctx: AppContext): void {
  // 1. The plugin registry, annotated with this user's connection state.
  app.get('/plugins', async (request, reply) => {
    const user = requireUser(ctx, request, reply);
    if (!user) return;

    const connections = new Map(
      listConnections(ctx.db, user.id).map((row) => [row.provider, row] as const),
    );

    return listProviders().map((provider) => {
      const connection = connections.get(provider.id);
      return {
        id: provider.id,
        name: provider.name,
        description: provider.description,
        icon: provider.icon,
        auth: provider.auth,
        connected: Boolean(connection),
        ...(connection?.account_label ? { accountLabel: connection.account_label } : {}),
      };
    });
  });

  // 2. Begin connecting a provider (browser redirect).
  app.get<{ Params: ProviderParams; Querystring: StartQuery }>(
    '/oauth/:provider/start',
    async (request, reply) => {
      const provider = getProvider(request.params.provider);
      if (!provider) {
        reply.code(404);
        return { error: 'unknown_provider', message: `No such provider: ${request.params.provider}` };
      }
      if (provider.auth === 'none') {
        reply.code(400);
        return { error: 'no_auth_required', message: `${provider.name} needs no connection.` };
      }

      const session = typeof request.query.session === 'string' ? request.query.session.trim() : '';
      const verified = session ? verifySession(session, ctx.config.sessionSecret) : undefined;
      if (!verified) {
        reply.code(401);
        return { error: 'unauthorized', message: 'A valid "session" token is required.' };
      }

      const redirectUri = `${ctx.config.publicUrl}/oauth/${provider.id}/callback`;
      try {
        const url = beginAuth(provider.id, redirectUri, encodeState(session, request.query.ext));
        return reply.redirect(url);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply.code(error instanceof OAuthError ? 400 : 500);
        return { error: 'oauth_start_failed', message };
      }
    },
  );

  // 3. Provider redirects back here with a code: store the encrypted tokens.
  app.get<{ Params: ProviderParams; Querystring: CallbackQuery }>(
    '/oauth/:provider/callback',
    async (request, reply) => {
      const provider = getProvider(request.params.provider);
      if (!provider) {
        reply.code(404);
        return { error: 'unknown_provider', message: `No such provider: ${request.params.provider}` };
      }
      const code = typeof request.query.code === 'string' ? request.query.code : '';
      if (!code) {
        reply.code(400);
        return { error: 'invalid_request', message: 'Missing "code".' };
      }

      const { session } = decodeState(request.query.state);
      const verified = session ? verifySession(session, ctx.config.sessionSecret) : undefined;
      if (!verified) {
        reply.code(401);
        return { error: 'unauthorized', message: 'Missing or invalid OAuth state.' };
      }

      const redirectUri = `${ctx.config.publicUrl}/oauth/${provider.id}/callback`;
      try {
        const tokens = await exchangeCode(provider.id, code, redirectUri);
        upsertConnection(ctx.db, {
          id: randomUUID(),
          userId: verified.userId,
          provider: provider.id,
          accountLabel: tokens.accountLabel ?? null,
          accessTokenCt: encryptString(tokens.accessToken, ctx.config.tokenKey),
          refreshTokenCt: tokens.refreshToken
            ? encryptString(tokens.refreshToken, ctx.config.tokenKey)
            : null,
          expiresAt: tokens.expiresAt ?? null,
          scopes: tokens.scopes,
        });

        reply.type('text/html; charset=utf-8');
        return successHtml(`✅ Connected ${provider.name} — you can close this tab.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply.code(400);
        return { error: 'oauth_callback_failed', message };
      }
    },
  );

  // 4. Disconnect.
  app.post<{ Params: ProviderParams }>('/oauth/:provider/disconnect', async (request, reply) => {
    const provider = getProvider(request.params.provider);
    if (!provider) {
      reply.code(404);
      return { error: 'unknown_provider', message: `No such provider: ${request.params.provider}` };
    }
    const user = requireUser(ctx, request, reply);
    if (!user) return;
    const removed = deleteConnection(ctx.db, user.id, provider.id);
    return { ok: true, disconnected: removed };
  });
}
