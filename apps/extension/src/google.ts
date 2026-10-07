/**
 * Google integration (Gmail + Calendar) for the extension.
 *
 * Uses the OAuth 2.0 **authorization-code flow with PKCE** through
 * `chrome.identity.launchWebAuthFlow`, so it works for an unpacked extension
 * without shipping a client secret. The user creates a Google Cloud "Web
 * application" OAuth client and registers the extension's redirect URL:
 *
 *     https://<extension-id>.chromiumapp.org/
 *
 * Tokens are stored in `chrome.storage.local` (`diggy:google`) and refreshed
 * automatically. Everything is read-only except creating calendar events.
 */
const TOKEN_KEY = 'diggy:google';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
];

interface StoredTokens {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email?: string;
  scopes: string[];
}

export interface GoogleStatus {
  connected: boolean;
  email?: string;
  expiresAt?: number;
  clientId?: string;
}

export interface InboxMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
  unread: boolean;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end?: string;
  location?: string;
  link?: string;
  allDay?: boolean;
}

/* ------------------------------------------------------------------ *
 * Token storage
 * ------------------------------------------------------------------ */

async function readTokens(): Promise<StoredTokens | null> {
  try {
    const store = (await browser.storage.local.get(TOKEN_KEY)) as Record<string, unknown>;
    return (store[TOKEN_KEY] as StoredTokens | undefined) ?? null;
  } catch {
    return null;
  }
}

async function writeTokens(tokens: StoredTokens | null): Promise<void> {
  if (tokens) await browser.storage.local.set({ [TOKEN_KEY]: tokens });
  else await browser.storage.local.remove(TOKEN_KEY);
}

/** The redirect URL that must be whitelisted on the Google OAuth client. */
export function googleRedirectUrl(): string {
  return browser.identity.getRedirectURL();
}

/* ------------------------------------------------------------------ *
 * PKCE helpers
 * ------------------------------------------------------------------ */

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(length = 64): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64Url(bytes).slice(0, length);
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/* ------------------------------------------------------------------ *
 * OAuth
 * ------------------------------------------------------------------ */

export async function connectGoogle(clientId: string): Promise<GoogleStatus> {
  const id = clientId.trim();
  if (!id) {
    throw new Error('No Google Client ID is configured. Add one in Settings (⚙) → Apps.');
  }

  const redirectUri = googleRedirectUrl();
  const verifier = randomString();
  const challenge = await challengeFor(verifier);
  const state = randomString(16);

  const authUrl = `${AUTH_ENDPOINT}?${new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    state,
  }).toString()}`;

  const resultUrl = await browser.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  if (!resultUrl) throw new Error('Google sign-in was cancelled.');

  const redirected = new URL(resultUrl);
  const code = redirected.searchParams.get('code');
  const error = redirected.searchParams.get('error');
  if (error) throw new Error(`Google returned: ${error}`);
  if (!code) throw new Error('No authorization code came back from Google.');

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: id,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }).toString(),
  });
  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description ?? `Token exchange failed (${response.status}).`);
  }

  const tokens: StoredTokens = {
    clientId: id,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? '',
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
    scopes: GOOGLE_SCOPES,
  };
  tokens.email = await fetchEmail(tokens.accessToken).catch(() => undefined);
  await writeTokens(tokens);
  return { connected: true, email: tokens.email, expiresAt: tokens.expiresAt, clientId: id };
}

export async function disconnectGoogle(): Promise<void> {
  const tokens = await readTokens();
  if (tokens?.accessToken) {
    await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(tokens.accessToken)}`, {
      method: 'POST',
    }).catch(() => undefined);
  }
  await writeTokens(null);
}

export async function googleStatus(): Promise<GoogleStatus> {
  const tokens = await readTokens();
  if (!tokens?.accessToken) return { connected: false };
  return {
    connected: true,
    email: tokens.email,
    expiresAt: tokens.expiresAt,
    clientId: tokens.clientId,
  };
}

async function fetchEmail(accessToken: string): Promise<string | undefined> {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return undefined;
  const payload = (await response.json()) as { email?: string };
  return payload.email;
}

/** A valid access token, refreshed if it is close to expiring. */
async function accessToken(): Promise<string> {
  const tokens = await readTokens();
  if (!tokens?.accessToken) throw new Error('Google is not connected.');
  if (tokens.expiresAt - Date.now() > 60_000) return tokens.accessToken;

  if (!tokens.refreshToken) throw new Error('Google session expired — reconnect in settings.');
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: tokens.clientId,
      refresh_token: tokens.refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const payload = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description ?? 'Could not refresh the Google token.');
  }
  const next: StoredTokens = {
    ...tokens,
    accessToken: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  };
  await writeTokens(next);
  return next.accessToken;
}

/* ------------------------------------------------------------------ *
 * Gmail
 * ------------------------------------------------------------------ */

function header(headers: { name?: string; value?: string }[] | undefined, name: string): string {
  const found = headers?.find((entry) => entry.name?.toLowerCase() === name.toLowerCase());
  return found?.value ?? '';
}

/** List recent inbox messages (readonly). */
export async function listInbox(options: { query?: string; max?: number } = {}): Promise<InboxMessage[]> {
  const token = await accessToken();
  const max = Math.min(Math.max(options.max ?? 8, 1), 25);
  const query = options.query?.trim() || 'in:inbox newer_than:2d';
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=${encodeURIComponent(query)}`;
  const listResponse = await fetch(listUrl, { headers: { authorization: `Bearer ${token}` } });
  if (!listResponse.ok) throw new Error(`Gmail list failed (${listResponse.status}).`);
  const list = (await listResponse.json()) as { messages?: { id: string; threadId: string }[] };

  const messages: InboxMessage[] = [];
  for (const item of list.messages ?? []) {
    const response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!response.ok) continue;
    const payload = (await response.json()) as {
      id: string;
      threadId: string;
      snippet?: string;
      labelIds?: string[];
      payload?: { headers?: { name?: string; value?: string }[] };
    };
    messages.push({
      id: payload.id,
      threadId: payload.threadId,
      from: header(payload.payload?.headers, 'From'),
      subject: header(payload.payload?.headers, 'Subject') || '(no subject)',
      snippet: payload.snippet ?? '',
      date: header(payload.payload?.headers, 'Date'),
      unread: (payload.labelIds ?? []).includes('UNREAD'),
    });
  }
  return messages;
}

/* ------------------------------------------------------------------ *
 * Calendar
 * ------------------------------------------------------------------ */

interface RawEvent {
  id: string;
  summary?: string;
  location?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

function mapEvent(event: RawEvent): CalendarEvent {
  const start = event.start?.dateTime ?? event.start?.date ?? '';
  return {
    id: event.id,
    summary: event.summary ?? '(no title)',
    start,
    end: event.end?.dateTime ?? event.end?.date,
    location: event.location,
    link: event.htmlLink,
    allDay: Boolean(event.start?.date && !event.start?.dateTime),
  };
}

/** Upcoming events from the primary calendar. */
export async function listUpcoming(days = 7, max = 10): Promise<CalendarEvent[]> {
  const token = await accessToken();
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + days * 86_400_000).toISOString();
  const url =
    'https://www.googleapis.com/calendar/v3/calendars/primary/events?' +
    new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(Math.min(Math.max(max, 1), 25)),
    }).toString();
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Calendar list failed (${response.status}).`);
  const payload = (await response.json()) as { items?: RawEvent[] };
  return (payload.items ?? []).map(mapEvent);
}

/* ------------------------------------------------------------------ *
 * "Already notified" bookkeeping
 * ------------------------------------------------------------------ */

const SEEN_KEY = 'diggy:google-seen';
const SEEN_LIMIT = 400;

export async function getSeenIds(): Promise<string[]> {
  try {
    const store = (await browser.storage.local.get(SEEN_KEY)) as Record<string, unknown>;
    const value = store[SEEN_KEY];
    return Array.isArray(value) ? (value as string[]) : [];
  } catch {
    return [];
  }
}

export async function addSeenIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const current = await getSeenIds();
  const merged = Array.from(new Set([...current, ...ids])).slice(-SEEN_LIMIT);
  try {
    await browser.storage.local.set({ [SEEN_KEY]: merged });
  } catch {
    /* ignore */
  }
}

/** Create a calendar event (used to mirror a reminder). */
export async function createEvent(input: {
  summary: string;
  start: string;
  end?: string;
  description?: string;
}): Promise<CalendarEvent> {
  const token = await accessToken();
  const start = input.start;
  const end = input.end ?? new Date(new Date(start).getTime() + 30 * 60_000).toISOString();
  const response = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        summary: input.summary,
        description: input.description,
        start: { dateTime: start },
        end: { dateTime: end },
      }),
    },
  );
  if (!response.ok) throw new Error(`Calendar insert failed (${response.status}).`);
  return mapEvent((await response.json()) as RawEvent);
}
