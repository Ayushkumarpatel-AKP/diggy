/**
 * Action routes: the actual "do something on the user's behalf" calls.
 *
 * `POST /actions/:provider/:action` authenticates with the session Bearer
 * token, loads the user's stored (encrypted) connection, transparently
 * refreshes expiring access tokens and proxies a small, well-known set of
 * actions to the provider's REST API.
 *
 * These routes return plain JSON — turning it into a RichCard is the
 * extension's job.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AppContext } from '../config.js';
import { decryptString, encryptString } from '../crypto.js';
import { getConnection, upsertConnection, type ConnectionRow } from '../db.js';
import { refresh } from '../oauth.js';
import { latestForChannel } from './preview.js';
import { requireUser } from './auth.js';

/** An input/upstream error carrying the HTTP status we should surface. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const GOOGLE_API = 'https://www.googleapis.com';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const GITHUB_API = 'https://api.github.com';

type Json = Record<string, unknown>;

function asObject(value: unknown): Json {
  return value && typeof value === 'object' ? (value as Json) : {};
}

function readString(body: Json, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function requireString(body: Json, key: string): string {
  const value = readString(body, key)?.trim();
  if (!value) throw new HttpError(400, 'invalid_request', `Field "${key}" is required.`);
  return value;
}

function readNumber(body: Json, key: string): number | undefined {
  const value = body[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

async function parseJson(response: Response): Promise<Json> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Json;
  } catch {
    return { raw: text };
  }
}

async function ensureOk(response: Response, fallback: string): Promise<Json> {
  const json = await parseJson(response);
  if (!response.ok) {
    const message =
      (typeof json.message === 'string' && json.message) ||
      (typeof json.error === 'string' && json.error) ||
      fallback;
    throw new HttpError(response.status === 401 ? 401 : 502, 'upstream_error', message);
  }
  return json;
}

/* ------------------------------------------------- per-connection auth ---- */

interface AccessContext {
  row: ConnectionRow;
  accessToken: string;
  refreshToken?: string;
}

function decryptRow(ctx: AppContext, row: ConnectionRow): AccessContext {
  return {
    row,
    accessToken: decryptString(row.access_token_ct, ctx.config.tokenKey),
    refreshToken: row.refresh_token_ct
      ? decryptString(row.refresh_token_ct, ctx.config.tokenKey)
      : undefined,
  };
}

function persistRefresh(ctx: AppContext, row: ConnectionRow, access: AccessContext, newAccess: string, newRefresh?: string): void {
  upsertConnection(ctx.db, {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    accountLabel: row.account_label,
    accessTokenCt: encryptString(newAccess, ctx.config.tokenKey),
    refreshTokenCt: newRefresh ? encryptString(newRefresh, ctx.config.tokenKey) : row.refresh_token_ct,
    expiresAt: row.expires_at,
    scopes: row.scopes,
  });
  access.accessToken = newAccess;
  if (newRefresh) access.refreshToken = newRefresh;
}

/**
 * Run a request that needs an access token, refreshing proactively when the
 * stored token has expired and once more if the provider answers 401.
 */
async function withAccess(
  ctx: AppContext,
  userId: string,
  provider: string,
  doFetch: (accessToken: string) => Promise<Response>,
): Promise<Response> {
  const row = getConnection(ctx.db, userId, provider);
  if (!row) {
    throw new HttpError(409, 'not_connected', `No ${provider} connection for this user.`);
  }
  const access = decryptRow(ctx, row);

  const expiring = row.expires_at ? Date.parse(row.expires_at) - Date.now() < 60_000 : false;
  if (expiring && access.refreshToken) {
    const refreshed = await refresh(provider, access.refreshToken);
    persistRefresh(ctx, row, access, refreshed.accessToken, refreshed.refreshToken);
  }

  let response = await doFetch(access.accessToken);
  if (response.status === 401 && access.refreshToken) {
    try {
      const refreshed = await refresh(provider, access.refreshToken);
      persistRefresh(ctx, row, access, refreshed.accessToken, refreshed.refreshToken);
      response = await doFetch(access.accessToken);
    } catch {
      /* fall through — surface the original 401 */
    }
  }
  return response;
}

/* --------------------------------------------------------- google: gmail - */

async function gmailList(ctx: AppContext, userId: string, body: Json): Promise<Json> {
  const query = readString(body, 'query')?.trim();
  const max = Math.min(Math.max(readNumber(body, 'max') ?? 10, 1), 50);

  const listResponse = await withAccess(ctx, userId, 'google', (token) => {
    const url = new URL(`${GMAIL_API}/messages`);
    url.searchParams.set('maxResults', String(max));
    if (query) url.searchParams.set('q', query);
    return fetch(url, { headers: { authorization: `Bearer ${token}` } });
  });
  const list = await ensureOk(listResponse, 'Failed to list Gmail messages');
  const ids = (Array.isArray(list.messages) ? list.messages : [])
    .map((message) => asObject(message).id)
    .filter((id): id is string => typeof id === 'string')
    .slice(0, max);

  const messages = await Promise.all(
    ids.map(async (id) => {
      const response = await withAccess(ctx, userId, 'google', (token) => {
        const url = new URL(`${GMAIL_API}/messages/${id}`);
        url.searchParams.set('format', 'metadata');
        for (const header of ['From', 'Subject', 'Date']) url.searchParams.append('metadataHeaders', header);
        return fetch(url, { headers: { authorization: `Bearer ${token}` } });
      });
      const message = await ensureOk(response, `Failed to read message ${id}`);
      const payload = asObject(message.payload);
      const headerList = Array.isArray(payload.headers) ? payload.headers : [];
      const header = (name: string): string => {
        const found = headerList
          .map((entry) => asObject(entry))
          .find((entry) => String(entry.name).toLowerCase() === name.toLowerCase());
        return typeof found?.value === 'string' ? found.value : '';
      };
      return {
        id,
        from: header('From'),
        subject: header('Subject'),
        date: header('Date'),
        snippet: typeof message.snippet === 'string' ? message.snippet : '',
      };
    }),
  );

  return { messages };
}

/* ------------------------------------------------------ google: calendar - */

async function calendarList(ctx: AppContext, userId: string, body: Json): Promise<Json> {
  const days = Math.min(Math.max(readNumber(body, 'days') ?? 7, 1), 90);
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const response = await withAccess(ctx, userId, 'google', (token) => {
    const url = new URL(`${GOOGLE_API}/calendar/v3/calendars/primary/events`);
    url.searchParams.set('timeMin', timeMin);
    url.searchParams.set('timeMax', timeMax);
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '25');
    return fetch(url, { headers: { authorization: `Bearer ${token}` } });
  });
  const data = await ensureOk(response, 'Failed to read Google Calendar');
  const items = Array.isArray(data.items) ? data.items : [];

  const events = items.map((item) => {
    const event = asObject(item);
    const start = asObject(event.start);
    const end = asObject(event.end);
    return {
      id: typeof event.id === 'string' ? event.id : '',
      summary: typeof event.summary === 'string' ? event.summary : '(no title)',
      start: (start.dateTime ?? start.date ?? '') as string,
      end: (end.dateTime ?? end.date ?? '') as string,
      location: typeof event.location === 'string' ? event.location : undefined,
      url: typeof event.htmlLink === 'string' ? event.htmlLink : undefined,
    };
  });

  return { timeMin, timeMax, events };
}

async function calendarCreate(ctx: AppContext, userId: string, body: Json): Promise<Json> {
  const summary = requireString(body, 'summary');
  const start = requireString(body, 'start');
  const startMs = Date.parse(start);
  if (Number.isNaN(startMs)) throw new HttpError(400, 'invalid_request', '"start" must be an ISO date-time.');
  const end = readString(body, 'end') ?? new Date(startMs + 60 * 60 * 1000).toISOString();

  const response = await withAccess(ctx, userId, 'google', (token) =>
    fetch(`${GOOGLE_API}/calendar/v3/calendars/primary/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ summary, start: { dateTime: start }, end: { dateTime: end } }),
    }),
  );
  const event = await ensureOk(response, 'Failed to create calendar event');
  return {
    id: typeof event.id === 'string' ? event.id : '',
    summary: typeof event.summary === 'string' ? event.summary : summary,
    start,
    end,
    url: typeof event.htmlLink === 'string' ? event.htmlLink : undefined,
  };
}

/* ---------------------------------------------------------------- notion - */

function notionHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'content-type': 'application/json',
  };
}

function notionTitle(page: Json): string {
  // Search results: properties.title.title[] or the page's own title.
  const properties = asObject(page.properties);
  for (const value of Object.values(properties)) {
    const prop = asObject(value);
    if (prop.type === 'title' && Array.isArray(prop.title)) {
      return prop.title
        .map((part) => (typeof asObject(part).plain_text === 'string' ? (asObject(part).plain_text as string) : ''))
        .join('')
        .trim();
    }
  }
  return '';
}

async function notionSearch(ctx: AppContext, userId: string, body: Json): Promise<Json> {
  const query = requireString(body, 'query');
  const response = await withAccess(ctx, userId, 'notion', (token) =>
    fetch(`${NOTION_API}/search`, {
      method: 'POST',
      headers: notionHeaders(token),
      body: JSON.stringify({ query, page_size: 20 }),
    }),
  );
  const data = await ensureOk(response, 'Notion search failed');
  const results = (Array.isArray(data.results) ? data.results : []).map((item) => {
    const result = asObject(item);
    return {
      id: typeof result.id === 'string' ? result.id : '',
      object: typeof result.object === 'string' ? result.object : '',
      title: notionTitle(result),
      url: typeof result.url === 'string' ? result.url : undefined,
      lastEdited: typeof result.last_edited_time === 'string' ? result.last_edited_time : undefined,
    };
  });
  return { results };
}

async function notionCreatePage(ctx: AppContext, userId: string, body: Json): Promise<Json> {
  const title = requireString(body, 'title');
  const content = readString(body, 'content');
  let parentId = readString(body, 'parentId')?.trim();

  if (!parentId) {
    const response = await withAccess(ctx, userId, 'notion', (token) =>
      fetch(`${NOTION_API}/search`, {
        method: 'POST',
        headers: notionHeaders(token),
        body: JSON.stringify({ filter: { property: 'object', value: 'page' }, page_size: 1 }),
      }),
    );
    const data = await ensureOk(response, 'Notion search failed');
    const first = Array.isArray(data.results) ? asObject(data.results[0]) : {};
    parentId = typeof first.id === 'string' ? first.id : undefined;
    if (!parentId) {
      throw new HttpError(
        400,
        'no_parent',
        'No parent page available. Share a page with the Diggy integration or pass "parentId".',
      );
    }
  }

  const children = content
    ? [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content } }] } }]
    : undefined;

  const response = await withAccess(ctx, userId, 'notion', (token) =>
    fetch(`${NOTION_API}/pages`, {
      method: 'POST',
      headers: notionHeaders(token),
      body: JSON.stringify({
        parent: { page_id: parentId },
        properties: { title: { title: [{ type: 'text', text: { content: title } }] } },
        ...(children ? { children } : {}),
      }),
    }),
  );
  const page = await ensureOk(response, 'Notion page creation failed');
  return {
    id: typeof page.id === 'string' ? page.id : '',
    title,
    url: typeof page.url === 'string' ? page.url : undefined,
  };
}

/* ---------------------------------------------------------------- github - */

async function githubMe(ctx: AppContext, userId: string): Promise<Json> {
  const response = await withAccess(ctx, userId, 'github', (token) =>
    fetch(`${GITHUB_API}/user`, { headers: { authorization: `Bearer ${token}`, 'user-agent': 'diggy', accept: 'application/vnd.github+json' } }),
  );
  const user = await ensureOk(response, 'Failed to read GitHub profile');
  return {
    login: typeof user.login === 'string' ? user.login : '',
    name: typeof user.name === 'string' ? user.name : undefined,
    avatarUrl: typeof user.avatar_url === 'string' ? user.avatar_url : undefined,
    url: typeof user.html_url === 'string' ? user.html_url : undefined,
    publicRepos: typeof user.public_repos === 'number' ? user.public_repos : undefined,
  };
}

async function githubListRepos(ctx: AppContext, userId: string, body: Json): Promise<Json> {
  const max = Math.min(Math.max(readNumber(body, 'max') ?? 30, 1), 100);
  const response = await withAccess(ctx, userId, 'github', (token) => {
    const url = new URL(`${GITHUB_API}/user/repos`);
    url.searchParams.set('per_page', String(max));
    url.searchParams.set('sort', 'updated');
    return fetch(url, { headers: { authorization: `Bearer ${token}`, 'user-agent': 'diggy', accept: 'application/vnd.github+json' } });
  });
  const data = await ensureOk(response, 'Failed to list GitHub repositories');
  const repos = (Array.isArray(data) ? data : []).map((item) => {
    const repo = asObject(item);
    return {
      fullName: typeof repo.full_name === 'string' ? repo.full_name : '',
      private: Boolean(repo.private),
      description: typeof repo.description === 'string' ? repo.description : undefined,
      url: typeof repo.html_url === 'string' ? repo.html_url : undefined,
    };
  });
  return { repos };
}

async function githubCreateIssue(ctx: AppContext, userId: string, body: Json): Promise<Json> {
  const repo = requireString(body, 'repo');
  const title = requireString(body, 'title');
  const issueBody = readString(body, 'body');

  const response = await withAccess(ctx, userId, 'github', (token) =>
    fetch(`${GITHUB_API}/repos/${repo}/issues`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'user-agent': 'diggy', accept: 'application/vnd.github+json', 'content-type': 'application/json' },
      body: JSON.stringify({ title, ...(issueBody ? { body: issueBody } : {}) }),
    }),
  );
  const issue = await ensureOk(response, 'Failed to create GitHub issue');
  return {
    number: typeof issue.number === 'number' ? issue.number : undefined,
    title: typeof issue.title === 'string' ? issue.title : title,
    url: typeof issue.html_url === 'string' ? issue.html_url : undefined,
  };
}

/* --------------------------------------------------------------- youtube - */

async function youtubeLatest(body: Json): Promise<Json> {
  const channel = requireString(body, 'channel');
  const video = await latestForChannel(channel);
  if (!video) throw new HttpError(404, 'not_found', `No latest video found for "${channel}".`);
  return video as unknown as Json;
}

/* ---------------------------------------------------------------- router - */

type ActionHandler = (
  ctx: AppContext,
  userId: string,
  body: Json,
) => Promise<Json>;

const ROUTES: Record<string, Record<string, ActionHandler>> = {
  google: {
    'gmail.list': gmailList,
    'calendar.list': calendarList,
    'calendar.create': calendarCreate,
  },
  notion: {
    search: notionSearch,
    createPage: notionCreatePage,
  },
  github: {
    me: githubMe,
    listRepos: githubListRepos,
    createIssue: githubCreateIssue,
  },
  youtube: {
    latest: (_ctx, _userId, body) => youtubeLatest(body),
  },
};

async function dispatch(
  ctx: AppContext,
  provider: string,
  action: string,
  userId: string,
  body: Json,
): Promise<Json> {
  const handler = ROUTES[provider]?.[action];
  if (!handler) {
    throw new HttpError(404, 'unknown_action', `No action "${provider}/${action}".`);
  }
  return handler(ctx, userId, body);
}

export function registerActionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Params: { provider: string; action: string }; Body: Json }>(
    '/actions/:provider/:action',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = (request.params ?? {}) as { provider?: string; action?: string };
      const provider = params.provider ?? '';
      const action = params.action ?? '';
      const body = asObject(request.body);

      // `youtube.latest` needs no connection, so it skips the session guard.
      if (provider === 'youtube' && action === 'latest') {
        try {
          return await dispatch(ctx, provider, action, '', body);
        } catch (error) {
          return fail(reply, error);
        }
      }

      const user = requireUser(ctx, request, reply);
      if (!user) return;

      try {
        return await dispatch(ctx, provider, action, user.id, body);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );
}

function fail(reply: FastifyReply, error: unknown): Json {
  if (error instanceof HttpError) {
    reply.code(error.status);
    return { error: error.code, message: error.message };
  }
  reply.code(500);
  return { error: 'internal_error', message: error instanceof Error ? error.message : String(error) };
}
