/**
 * OAuth provider glue: authorize/token URLs, scope strings and how to derive a
 * human-readable account label after a successful exchange.
 *
 * The server owns the OAuth apps, so the extension never sees a client secret
 * and the user never pastes a URL or a token — they just click "Connect", land
 * on the provider, and come back.
 */
import { getContext, type OAuthCredentials } from './config.js';
import type { ProviderId } from './providers.js';

export class OAuthError extends Error {
  constructor(
    message: string,
    /** Stable machine code, e.g. `not_configured` or `unsupported_provider`. */
    readonly code: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** ISO timestamp when the access token expires, when the provider says. */
  expiresAt?: string;
  /** Space-delimited granted scopes. */
  scopes: string;
  /** e.g. the Google email or the GitHub login. */
  accountLabel?: string;
}

type OAuthProviderId = Exclude<ProviderId, 'youtube'>;

interface ProviderOAuthSpec {
  authorizeUrl: string;
  tokenUrl: string;
  extraAuthorizeParams?: Record<string, string>;
  /** Notion authenticates the token request with HTTP Basic. */
  basicAuthToken?: boolean;
}

const SPECS: Record<OAuthProviderId, ProviderOAuthSpec> = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    extraAuthorizeParams: {
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    },
  },
  notion: {
    authorizeUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    extraAuthorizeParams: { owner: 'user' },
    basicAuthToken: true,
  },
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    extraAuthorizeParams: { allow_signup: 'true' },
  },
};

const SCOPES: Record<OAuthProviderId, string> = {
  google: [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar',
  ].join(' '),
  notion: '',
  github: 'read:user repo',
};

export function isOAuthProvider(id: string): id is OAuthProviderId {
  return id in SPECS;
}

function credentialsFor(provider: OAuthProviderId, creds?: OAuthCredentials): OAuthCredentials {
  return creds ?? getContext().config.providers[provider];
}

function requireCredentials(
  provider: OAuthProviderId,
  creds?: OAuthCredentials,
): Required<OAuthCredentials> {
  const resolved = credentialsFor(provider, creds);
  if (!resolved.clientId || !resolved.clientSecret) {
    throw new OAuthError(
      `${provider} is not configured on the server (missing client id/secret)`,
      'not_configured',
    );
  }
  return { clientId: resolved.clientId, clientSecret: resolved.clientSecret };
}

/** Build the provider authorize URL the browser should be redirected to. */
export function beginAuth(
  provider: string,
  redirectUri: string,
  state: string,
  creds?: OAuthCredentials,
): string {
  if (!isOAuthProvider(provider)) {
    throw new OAuthError(`Unknown OAuth provider: ${provider}`, 'unsupported_provider');
  }
  const { clientId } = requireCredentials(provider, creds);
  const spec = SPECS[provider];

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
  });
  const scope = SCOPES[provider];
  if (scope) params.set('scope', scope);
  for (const [key, value] of Object.entries(spec.extraAuthorizeParams ?? {})) {
    params.set(key, value);
  }
  return `${spec.authorizeUrl}?${params.toString()}`;
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  return text ? `${response.status} ${text.slice(0, 300)}` : `${response.status}`;
}

interface GenericTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  // Notion extras
  workspace_name?: string;
  bot_id?: string;
  owner?: unknown;
}

function toTokenSet(provider: OAuthProviderId, raw: GenericTokenResponse): TokenSet {
  if (!raw.access_token) {
    throw new OAuthError(`No access_token returned by ${provider}`, 'token_exchange_failed');
  }
  const token: TokenSet = {
    accessToken: raw.access_token,
    scopes: raw.scope ?? SCOPES[provider],
  };
  if (raw.refresh_token) token.refreshToken = raw.refresh_token;
  if (typeof raw.expires_in === 'number') {
    token.expiresAt = new Date(Date.now() + raw.expires_in * 1000).toISOString();
  }
  if (raw.workspace_name) token.accountLabel = raw.workspace_name;
  return token;
}

/** Exchange an authorization `code` for tokens, then enrich the label. */
export async function exchangeCode(
  provider: string,
  code: string,
  redirectUri: string,
  creds?: OAuthCredentials,
): Promise<TokenSet> {
  if (!isOAuthProvider(provider)) {
    throw new OAuthError(`Unknown OAuth provider: ${provider}`, 'unsupported_provider');
  }
  const { clientId, clientSecret } = requireCredentials(provider, creds);
  const spec = SPECS[provider];

  let body: GenericTokenResponse;
  if (spec.basicAuthToken) {
    const response = await fetch(spec.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    });
    if (!response.ok) {
      throw new OAuthError(`Token exchange failed: ${await readError(response)}`, 'token_exchange_failed');
    }
    body = (await response.json()) as GenericTokenResponse;
  } else {
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });
    const response = await fetch(spec.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: params.toString(),
    });
    if (!response.ok) {
      throw new OAuthError(`Token exchange failed: ${await readError(response)}`, 'token_exchange_failed');
    }
    body = (await response.json()) as GenericTokenResponse;
  }

  const token = toTokenSet(provider, body);
  if (!token.accountLabel) {
    token.accountLabel = await fetchAccountLabel(provider, token.accessToken);
  }
  return token;
}

/** Refresh an access token. GitHub/Notion tokens are long-lived and unsupported. */
export async function refresh(
  provider: string,
  refreshToken: string,
  creds?: OAuthCredentials,
): Promise<TokenSet> {
  if (provider === 'google') {
    const { clientId, clientSecret } = requireCredentials('google', creds);
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const response = await fetch(SPECS.google.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: params.toString(),
    });
    if (!response.ok) {
      throw new OAuthError(`Token refresh failed: ${await readError(response)}`, 'token_refresh_failed');
    }
    const body = (await response.json()) as GenericTokenResponse;
    const token = toTokenSet('google', body);
    // A refresh response omits refresh_token; keep the one we already have.
    token.refreshToken = refreshToken;
    return token;
  }
  if (isOAuthProvider(provider)) {
    throw new OAuthError(`${provider} tokens do not expire and cannot be refreshed`, 'refresh_unsupported');
  }
  throw new OAuthError(`Unknown OAuth provider: ${provider}`, 'unsupported_provider');
}

interface GoogleProfile {
  sub?: string;
  email?: string;
  name?: string;
  picture?: string;
}

/** Resolve a display label for a freshly-issued token. */
export async function fetchAccountLabel(
  provider: string,
  accessToken: string,
): Promise<string | undefined> {
  try {
    if (provider === 'google') {
      const profile = await fetchGoogleProfile(accessToken);
      return profile.email;
    }
    if (provider === 'github') {
      const response = await fetch('https://api.github.com/user', {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json', 'user-agent': 'diggy' },
      });
      if (!response.ok) return undefined;
      const user = (await response.json()) as { login?: string };
      return user.login;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Look up the signed-in Google identity (sub/email/name/picture). */
export async function fetchGoogleProfile(accessToken: string): Promise<GoogleProfile> {
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Google userinfo responded ${response.status}`);
  return (await response.json()) as GoogleProfile;
}
