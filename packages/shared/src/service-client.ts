/**
 * Service client — the extension's single seam for "the crawler / a hosted backend".
 *
 * Today the extension talks to the local crawler on `http://127.0.0.1:17322`
 * with hard-coded `fetch` calls, which bakes "there is a local crawler" into the
 * agent. This module replaces that with a narrow interface ({@link ServiceClient})
 * and two implementations:
 *
 *  - {@link LocalServiceClient} — the loopback crawler: the same requests and the
 *    same tolerant parsing the extension makes today (never throws; a failure
 *    resolves to `undefined` / `[]`);
 *  - {@link HostedServiceClient} — the same interface over a remote base URL with
 *    a bearer token, so a hosted backend can drop in without touching the agent.
 *
 * The package has **no runtime dependencies**: every request is a plain `fetch`,
 * and nothing here runs at import time (no DOM-only APIs at module scope).
 */

/* ------------------------------------------------------------------ *
 * Result shapes
 * ------------------------------------------------------------------ */

/** A page extracted to clean, LLM-ready text. */
export interface ExtractResult {
  url: string;
  title: string;
  text: string;
}

/** One web-search hit. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** A video/audio transcript. `source` names the backend that produced it. */
export interface TranscriptResult {
  title?: string;
  language?: string;
  text: string;
  source: string;
}

/** A feed (RSS / Atom) with its items. */
export interface FeedResult {
  title?: string;
  items: { title: string; link: string; published?: string; summary?: string }[];
}

/* ------------------------------------------------------------------ *
 * The interface
 * ------------------------------------------------------------------ */

/**
 * What the agent needs from "a service that can read the web".
 *
 * `kind` tells the caller which implementation it is talking to; the optional
 * `oauthStart` is only meaningful for a backend that hosts OAuth itself.
 */
export interface ServiceClient {
  readonly kind: 'local' | 'hosted';
  extract(url: string): Promise<ExtractResult | undefined>;
  search(query: string, max?: number): Promise<SearchResult[]>;
  transcript(url: string, language?: string): Promise<TranscriptResult | undefined>;
  feed(url: string, max?: number): Promise<FeedResult | undefined>;
  /** Returns a URL the caller should open to begin an OAuth flow. */
  oauthStart?(provider: string): Promise<string | undefined>;
}

export type ServiceKind = 'local' | 'hosted';

/** Configuration accepted by {@link createServiceClient}. */
export interface ServiceClientConfig {
  baseUrl: string;
  /** Sent as `x-diggy-token` (local) or as a bearer token (hosted). */
  token?: string;
  timeoutMs?: number;
}

/* ------------------------------------------------------------------ *
 * Pure parsing helpers (exported so they can be unit tested)
 * ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asTrimmed(value: unknown): string {
  return asString(value)?.trim() ?? '';
}

/** Cap an array to `max` when a finite, non-negative limit is given. */
function cap<T>(items: T[], max: number | undefined): T[] {
  return typeof max === 'number' && Number.isFinite(max) && max >= 0 ? items.slice(0, max) : items;
}

/**
 * Read an `/extract` response (`{ title, markdown, provider }`) into an
 * {@link ExtractResult}. Accepts `text` as an alias for `markdown`. Returns
 * `undefined` when there is no usable body text.
 */
export function parseExtractPayload(payload: unknown, url: string): ExtractResult | undefined {
  const record = asRecord(payload);
  if (!record) return undefined;
  const title = asTrimmed(record.title);
  const text = asTrimmed(record.markdown) || asTrimmed(record.text);
  if (!text) return undefined;
  return { url, title: title || url, text };
}

/**
 * Read a `/search` response (`{ query, results, offline }`) — or a bare array —
 * into {@link SearchResult}s. Entries without a URL are dropped; never throws.
 */
export function parseSearchPayload(payload: unknown, max?: number): SearchResult[] {
  const record = asRecord(payload);
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray(record?.results)
      ? record.results
      : [];

  const results: SearchResult[] = [];
  for (const entry of raw) {
    const item = asRecord(entry);
    if (!item) continue;
    const url = asTrimmed(item.url);
    if (!url) continue;
    results.push({
      url,
      title: asTrimmed(item.title) || url,
      snippet: asTrimmed(item.snippet),
    });
  }
  return cap(results, max);
}

/**
 * Read a `/transcript` response into a {@link TranscriptResult}. `source`
 * defaults to `yt-dlp` (the crawler's backend) when the payload omits it.
 * Returns `undefined` when there is no transcript text (e.g. the offline stub).
 */
export function parseTranscriptPayload(payload: unknown): TranscriptResult | undefined {
  const record = asRecord(payload);
  if (!record) return undefined;
  const text = asTrimmed(record.text);
  if (!text) return undefined;

  const result: TranscriptResult = { text, source: asTrimmed(record.source) || 'yt-dlp' };
  const title = asTrimmed(record.title);
  if (title) result.title = title;
  const language = asTrimmed(record.language);
  if (language) result.language = language;
  return result;
}

/**
 * Read a `/feed` response into a {@link FeedResult}. Entries without a link are
 * dropped. Returns `undefined` when the payload carries no `items` array; an
 * empty `items` array (the offline stub) is a valid, empty feed.
 */
export function parseFeedPayload(payload: unknown, max?: number): FeedResult | undefined {
  const record = asRecord(payload);
  if (!record || !Array.isArray(record.items)) return undefined;

  const items: FeedResult['items'] = [];
  for (const entry of record.items) {
    const item = asRecord(entry);
    if (!item) continue;
    const link = asTrimmed(item.link);
    if (!link) continue;
    const parsed: FeedResult['items'][number] = { title: asTrimmed(item.title) || link, link };
    const published = asTrimmed(item.published);
    if (published) parsed.published = published;
    const summary = asTrimmed(item.summary);
    if (summary) parsed.summary = summary;
    items.push(parsed);
  }

  const feed: FeedResult = { items: cap(items, max) };
  const title = asTrimmed(record.title);
  if (title) feed.title = title;
  return feed;
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

const DEFAULT_TIMEOUT_MS = 20_000;

type HttpMethod = 'GET' | 'POST';

interface JsonRequest {
  method: HttpMethod;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

/** Normalise a base URL: trim, drop trailing slashes. Empty stays empty. */
function normalizeBase(baseUrl: string): string {
  return (baseUrl ?? '').trim().replace(/\/+$/, '');
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_TIMEOUT_MS;
}

/**
 * Small private fetch wrapper shared by both clients: builds the URL, attaches
 * the auth headers, applies a timeout, and swallows every failure into
 * `undefined`. POSTs always send `content-type: application/json`.
 */
class Requester {
  constructor(
    private readonly base: string,
    private readonly timeoutMs: number,
    private readonly authHeaders: () => Record<string, string>,
  ) {}

  async json(path: string, request: JsonRequest): Promise<unknown | undefined> {
    if (!this.base) return undefined;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
        ...this.authHeaders(),
      };
      const init: RequestInit = { method: request.method, headers, signal: controller.signal };
      if (request.method === 'POST') {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(request.body ?? {});
      }

      const response = await fetch(this.url(path, request.query), init);
      if (!response.ok) return undefined;
      return (await response.json()) as unknown;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private url(
    path: string,
    query: Record<string, string | number | boolean | undefined> | undefined,
  ): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      params.set(key, String(value));
    }
    const search = params.toString();
    return `${this.base}${path}${search ? `?${search}` : ''}`;
  }
}

/* ------------------------------------------------------------------ *
 * Clients
 * ------------------------------------------------------------------ */

/** Options for {@link LocalServiceClient}. */
export interface LocalServiceClientOptions {
  /** Shared secret the local crawler checks via the `x-diggy-token` header. */
  token?: string;
  /** Per-request timeout in milliseconds. Defaults to 20 s. */
  timeoutMs?: number;
}

/**
 * Talks to the local crawler service over loopback.
 *
 * This reproduces the extension's current behaviour exactly: the same paths
 * (`/extract`, `/search`, `/transcript`, `/feed`), the same L1 parsing, and the
 * same "return `undefined` / `[]` instead of throwing" tolerance.
 */
export class LocalServiceClient implements ServiceClient {
  readonly kind = 'local' as const;
  private readonly requester: Requester;

  constructor(baseUrl: string, options: LocalServiceClientOptions = {}) {
    const token = options.token;
    this.requester = new Requester(
      normalizeBase(baseUrl),
      normalizeTimeout(options.timeoutMs),
      () => {
        const headers: Record<string, string> = {};
        if (token) headers['x-diggy-token'] = token;
        return headers;
      },
    );
  }

  async extract(url: string): Promise<ExtractResult | undefined> {
    if (!url?.trim()) return undefined;
    const payload = await this.requester.json('/extract', {
      method: 'POST',
      body: { url },
    });
    return parseExtractPayload(payload, url);
  }

  async search(query: string, max = 8): Promise<SearchResult[]> {
    const trimmed = query?.trim();
    if (!trimmed) return [];
    const payload = await this.requester.json('/search', {
      method: 'GET',
      query: { q: trimmed },
    });
    return parseSearchPayload(payload, max);
  }

  async transcript(url: string, language?: string): Promise<TranscriptResult | undefined> {
    if (!url?.trim()) return undefined;
    const payload = await this.requester.json('/transcript', {
      method: 'GET',
      query: { url, lang: language },
    });
    return parseTranscriptPayload(payload);
  }

  async feed(url: string, max = 10): Promise<FeedResult | undefined> {
    if (!url?.trim()) return undefined;
    const payload = await this.requester.json('/feed', {
      method: 'GET',
      query: { url, max },
    });
    return parseFeedPayload(payload, max);
  }
}

/**
 * Same interface over a remote base URL, authenticated with a bearer token.
 *
 * A working stub: it reuses the {@link LocalServiceClient} transport with an
 * `authorization: bearer <token>` header, so a hosted backend that speaks the
 * same routes drops straight in. The constructor never throws.
 */
export class HostedServiceClient implements ServiceClient {
  readonly kind = 'hosted' as const;
  private readonly requester: Requester;

  constructor(baseUrl: string, authToken: string, timeoutMs?: number) {
    const token = (authToken ?? '').trim();
    this.requester = new Requester(normalizeBase(baseUrl), normalizeTimeout(timeoutMs), () => {
      const headers: Record<string, string> = {};
      if (token) headers['authorization'] = `Bearer ${token}`;
      return headers;
    });
  }

  async extract(url: string): Promise<ExtractResult | undefined> {
    if (!url?.trim()) return undefined;
    const payload = await this.requester.json('/extract', {
      method: 'POST',
      body: { url },
    });
    return parseExtractPayload(payload, url);
  }

  async search(query: string, max = 8): Promise<SearchResult[]> {
    const trimmed = query?.trim();
    if (!trimmed) return [];
    const payload = await this.requester.json('/search', {
      method: 'GET',
      query: { q: trimmed },
    });
    return parseSearchPayload(payload, max);
  }

  async transcript(url: string, language?: string): Promise<TranscriptResult | undefined> {
    if (!url?.trim()) return undefined;
    const payload = await this.requester.json('/transcript', {
      method: 'GET',
      query: { url, lang: language },
    });
    return parseTranscriptPayload(payload);
  }

  async feed(url: string, max = 10): Promise<FeedResult | undefined> {
    if (!url?.trim()) return undefined;
    const payload = await this.requester.json('/feed', {
      method: 'GET',
      query: { url, max },
    });
    return parseFeedPayload(payload, max);
  }

  /**
   * Stub: asks the backend for an OAuth start URL
   * (`GET /oauth/:provider/start` → `{ url }`) and returns it, or `undefined`
   * when the backend does not expose one.
   */
  async oauthStart(provider: string): Promise<string | undefined> {
    const name = provider?.trim();
    if (!name) return undefined;
    const payload = await this.requester.json(`/oauth/${encodeURIComponent(name)}/start`, {
      method: 'GET',
    });
    const record = asRecord(payload);
    return (asTrimmed(record?.url) || asTrimmed(record?.redirectUrl)) || undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Factory
 * ------------------------------------------------------------------ */

/** Build the client for a given kind. Unknown kinds fall back to `local`. */
export function createServiceClient(kind: ServiceKind, config: ServiceClientConfig): ServiceClient {
  if (kind === 'hosted') {
    return new HostedServiceClient(config.baseUrl, config.token ?? '', config.timeoutMs);
  }
  return new LocalServiceClient(config.baseUrl, {
    token: config.token,
    timeoutMs: config.timeoutMs,
  });
}
