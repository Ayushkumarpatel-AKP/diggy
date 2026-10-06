/**
 * api-client — a small, dependency-free typed client for the local Diggy API
 * server (Fastify on `http://127.0.0.1:17323`).
 *
 * It owns the extension ↔ backend handshake:
 *
 *   1. `signInWithGoogle()` generates a random pairing code, opens
 *      `${base}/auth/google/start?pair=<code>&ext=<id>` in a NEW TAB and polls
 *      `GET ${base}/auth/pair/claim?code=<code>` until the server hands back
 *      `{ token, user }` exactly once (404 / `{pending:true}` until then).
 *   2. The session (`{ token, user, apiUrl }`) is cached in
 *      `chrome.storage.local` under `diggy:api` — via the typed `browser`
 *      global (the same API as `chrome.*`).
 *   3. Every request goes through one helper with an `AbortController` timeout
 *      (~8s for requests, 60s for polling) and friendly error messages.
 *
 * `apiHealth()` is intentionally swallow-all and never throws — the UI uses it
 * to decide whether to show "Backend not running".
 *
 * The `storage` / `tabs` / `runtime` calls use the extension-global `browser`
 * object (typed by wxt; identical to `chrome.*`).
 */

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export interface ApiUser {
  id: string;
  email: string;
  name?: string;
  picture?: string;
}

/** The cached session: token + user + the base URL it was minted against. */
export interface ApiSession {
  token: string;
  user: ApiUser;
  apiUrl: string;
}

/** `GET /health` payload. */
export interface ApiHealth {
  status: 'ok';
  service: string;
  plugins: number;
}

export type PluginAuth = 'oauth2' | 'none';

/** One row of `GET /plugins`. */
export interface ApiPlugin {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  auth: PluginAuth;
  connected: boolean;
  accountLabel?: string;
}

/** Typed client error so callers can show a clean message. */
export class ApiClientError extends Error {
  /** HTTP status, or `0` for a network / timeout failure. */
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
  }
}

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const STORAGE_KEY = 'diggy:api';
const SETTINGS_KEY = 'diggy:settings';
export const DEFAULT_API_URL = 'http://127.0.0.1:17323';
const REQUEST_TIMEOUT_MS = 8_000;
const POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_500;
const MAX_NETWORK_FAILURES = 4;

export const BACKEND_DOWN_MESSAGE =
  'Backend not running — start `pnpm --filter @diggy/api start`.';

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The extension id, used as `?ext=` on the auth/oauth hand-off URLs. */
function extensionId(): string {
  try {
    const id = browser.runtime.id;
    return typeof id === 'string' ? id : '';
  } catch {
    return '';
  }
}

/** Open a URL in a new tab (falls back to `window.open` off-extension). */
async function openTab(url: string): Promise<void> {
  try {
    await browser.tabs.create({ url });
  } catch {
    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      /* nothing else we can do — the caller surfaces the failure */
    }
  }
}

function normalizeUser(value: unknown): ApiUser {
  if (!isObject(value)) return { id: '', email: '' };
  return {
    id: str(value.id) ?? '',
    email: str(value.email) ?? '',
    name: str(value.name),
    picture: str(value.picture),
  };
}

function normalizePlugins(value: unknown): ApiPlugin[] {
  if (!Array.isArray(value)) return [];
  const out: ApiPlugin[] = [];
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const id = str(entry.id);
    if (!id) continue;
    out.push({
      id,
      name: str(entry.name) ?? id,
      description: str(entry.description),
      icon: str(entry.icon),
      auth: entry.auth === 'oauth2' ? 'oauth2' : 'none',
      connected: entry.connected === true,
      accountLabel: str(entry.accountLabel),
    });
  }
  return out;
}

function detailFrom(data: unknown): string | undefined {
  if (typeof data === 'string' && data.trim().length > 0) return data.trim();
  if (isObject(data)) {
    return str(data.error) ?? str(data.message) ?? str(data.detail);
  }
  return undefined;
}

function httpError(status: number, data: unknown): string {
  const detail = detailFrom(data);
  if (status === 401) return detail ?? 'Your Diggy session expired — sign in again.';
  if (status === 403) return detail ?? 'The Diggy API refused that request.';
  if (status === 404) return detail ?? 'The Diggy API did not find that endpoint.';
  if (status >= 500) return detail ?? `The Diggy API errored (${status}).`;
  return detail ?? `The Diggy API request failed (${status}).`;
}

/** A persistent, human-friendly pairing code (24 random bytes as hex). */
function generatePairingCode(): string {
  const bytes = new Uint8Array(24);
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
  } catch {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

/**
 * The API base URL: the session's `apiUrl` if present, else a defensively-read
 * `apiUrl` from the stored settings (the `Settings` type does not expose it),
 * else {@link DEFAULT_API_URL}.
 */
export async function apiBase(): Promise<string> {
  try {
    const store = (await browser.storage.local.get([STORAGE_KEY, SETTINGS_KEY])) as Record<
      string,
      unknown
    >;
    const session = store[STORAGE_KEY];
    if (isObject(session)) {
      const fromSession = str(session.apiUrl);
      if (fromSession) return fromSession.replace(/\/+$/, '');
    }
    const settings = store[SETTINGS_KEY];
    if (isObject(settings)) {
      const fromSettings = str(settings.apiUrl);
      if (fromSettings) return fromSettings.replace(/\/+$/, '');
    }
  } catch {
    /* fall through to the default */
  }
  return DEFAULT_API_URL;
}

/** The cached session, or `null` when signed out. Never throws. */
export async function getSession(): Promise<ApiSession | null> {
  try {
    const store = (await browser.storage.local.get(STORAGE_KEY)) as Record<string, unknown>;
    const value = store[STORAGE_KEY];
    if (!isObject(value)) return null;
    const token = str(value.token);
    if (!token) return null;
    return {
      token,
      user: normalizeUser(value.user),
      apiUrl: str(value.apiUrl) ?? DEFAULT_API_URL,
    };
  } catch {
    return null;
  }
}

/** Persist a session. Returns the stored shape. */
export async function setSession(input: {
  token: string;
  user: ApiUser;
  apiUrl?: string;
}): Promise<ApiSession> {
  const session: ApiSession = {
    token: input.token,
    user: input.user,
    apiUrl: (input.apiUrl ?? (await apiBase())).replace(/\/+$/, ''),
  };
  try {
    await browser.storage.local.set({ [STORAGE_KEY]: session });
  } catch {
    /* storage unavailable — the caller still gets the value back */
  }
  return session;
}

/** Forget the cached session. Never throws. */
export async function clearSession(): Promise<void> {
  try {
    await browser.storage.local.remove(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** True when a token is cached. */
export async function isSignedIn(): Promise<boolean> {
  return (await getSession()) !== null;
}

async function requireSession(): Promise<ApiSession> {
  const session = await getSession();
  if (!session) throw new ApiClientError('Not signed in — sign in with Google first.', 401);
  return session;
}

/* ------------------------------------------------------------------ *
 * HTTP core
 * ------------------------------------------------------------------ */

interface RequestOptions {
  method?: string;
  token?: string | null;
  body?: unknown;
  timeoutMs?: number;
}

interface RawResponse {
  ok: boolean;
  status: number;
  data: unknown;
}

/**
 * One request. Throws {@link ApiClientError} on network failure / timeout;
 * HTTP error statuses are returned (not thrown) so polling can inspect them.
 */
async function rawRequest(path: string, options: RequestOptions = {}): Promise<RawResponse> {
  const base = await apiBase();
  const url = /^https?:/i.test(path) ? path : `${base}${path}`;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.token) headers.authorization = `Bearer ${options.token}`;

    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    const text = await response.text();
    let data: unknown = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiClientError(
        `The Diggy API did not answer within ${Math.round(timeoutMs / 1000)}s.`,
        0,
      );
    }
    throw new ApiClientError(BACKEND_DOWN_MESSAGE, 0);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * Health
 * ------------------------------------------------------------------ */

/** `GET /health`. Never throws — resolves `null` when the backend is down. */
export async function apiHealth(): Promise<ApiHealth | null> {
  try {
    const response = await rawRequest('/health');
    if (!response.ok || !isObject(response.data)) return null;
    const data = response.data;
    if (data.status !== 'ok') return null;
    return {
      status: 'ok',
      service: str(data.service) ?? '@diggy/api',
      plugins: typeof data.plugins === 'number' ? data.plugins : 0,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

/**
 * Pairing sign-in. Opens the Google sign-in tab, then polls the claim endpoint
 * until the server returns `{ token, user }` (once), caching the session.
 * Resolves the signed-in user, or throws a clear error.
 */
export async function signInWithGoogle(): Promise<ApiUser> {
  const base = await apiBase();
  const code = generatePairingCode();
  const startUrl =
    `${base}/auth/google/start?pair=${encodeURIComponent(code)}` +
    `&ext=${encodeURIComponent(extensionId())}`;

  await openTab(startUrl);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let networkFailures = 0;
  let lastNetworkError: string | null = null;
  let polled = false;

  while (Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS);
    polled = true;

    let response: RawResponse;
    try {
      response = await rawRequest(`/auth/pair/claim?code=${encodeURIComponent(code)}`);
      networkFailures = 0;
    } catch (error) {
      networkFailures += 1;
      lastNetworkError = error instanceof Error ? error.message : String(error);
      if (networkFailures >= MAX_NETWORK_FAILURES) {
        throw new ApiClientError(lastNetworkError, 0);
      }
      continue;
    }

    if (response.status === 404) continue; // still pending
    if (!response.ok) throw new ApiClientError(httpError(response.status, response.data), response.status);

    if (isObject(response.data)) {
      if (response.data.pending === true) continue;
      const token = str(response.data.token);
      if (token) {
        const user = normalizeUser(response.data.user);
        await setSession({ token, user, apiUrl: base });
        return user;
      }
    }
  }

  throw new ApiClientError(
    polled && lastNetworkError
      ? lastNetworkError
      : 'Sign-in timed out — finish signing in with Google in the new tab, then try again.',
    0,
  );
}

/**
 * The signed-in user. Tries `GET /auth/me` to refresh; falls back to the cached
 * session user when that endpoint is unavailable, and clears the session on 401.
 */
export async function apiMe(): Promise<ApiUser | null> {
  const session = await getSession();
  if (!session) return null;

  let response: RawResponse;
  try {
    response = await rawRequest('/auth/me', { token: session.token });
  } catch {
    return session.user;
  }

  if (response.ok && isObject(response.data)) {
    const user = normalizeUser(response.data);
    if (user.id || user.email) {
      await setSession({ token: session.token, user, apiUrl: session.apiUrl });
      return user;
    }
    return session.user;
  }
  if (response.status === 401) {
    await clearSession();
    throw new ApiClientError('Your Diggy session expired — sign in again.', 401);
  }
  // 404 / 405 etc. — the endpoint isn't there; the cached user is still valid.
  return session.user;
}

/* ------------------------------------------------------------------ *
 * Plugins
 * ------------------------------------------------------------------ */

/** `GET /plugins` (Bearer). Throws when signed out or the request fails. */
export async function listPlugins(): Promise<ApiPlugin[]> {
  const session = await requireSession();
  const response = await rawRequest('/plugins', { token: session.token });
  if (!response.ok) throw new ApiClientError(httpError(response.status, response.data), response.status);
  return normalizePlugins(response.data);
}

/**
 * `POST /oauth/<provider>/disconnect` (Bearer). Throws on failure.
 */
export async function disconnectPlugin(provider: string): Promise<void> {
  const session = await requireSession();
  const response = await rawRequest(
    `/oauth/${encodeURIComponent(provider)}/disconnect`,
    { method: 'POST', token: session.token },
  );
  if (!response.ok) throw new ApiClientError(httpError(response.status, response.data), response.status);
}

/**
 * Connect a plugin: opens `${base}/oauth/<provider>/start?session=<token>&ext=<id>`
 * in a NEW TAB, then polls `GET /plugins` every {@link POLL_INTERVAL_MS} for up
 * to ~60s until that plugin reports `connected`. Resolves the connected plugin,
 * or throws on timeout / failure.
 */
export async function connectPlugin(provider: string): Promise<ApiPlugin> {
  const session = await requireSession();
  const base = await apiBase();
  const startUrl =
    `${base}/oauth/${encodeURIComponent(provider)}/start` +
    `?session=${encodeURIComponent(session.token)}` +
    `&ext=${encodeURIComponent(extensionId())}`;

  await openTab(startUrl);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS);

    let plugins: ApiPlugin[];
    try {
      plugins = await listPlugins();
    } catch (error) {
      // Hard auth failures are fatal; transient errors keep us polling.
      if (error instanceof ApiClientError && error.status === 401) throw error;
      continue;
    }

    const match = plugins.find((plugin) => plugin.id === provider);
    if (match && match.connected) return match;
  }

  throw new ApiClientError(
    `Timed out waiting for “${provider}” to connect — finish the sign-in in the new tab and try again.`,
    0,
  );
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

/**
 * `POST /actions/<provider>/<action>` (Bearer) with a JSON body. Returns the
 * provider-specific JSON response.
 */
export async function runAction(
  provider: string,
  action: string,
  input: unknown = {},
): Promise<unknown> {
  const session = await requireSession();
  const response = await rawRequest(
    `/actions/${encodeURIComponent(provider)}/${encodeURIComponent(action)}`,
    { method: 'POST', token: session.token, body: input ?? {} },
  );
  if (!response.ok) throw new ApiClientError(httpError(response.status, response.data), response.status);
  return response.data;
}
