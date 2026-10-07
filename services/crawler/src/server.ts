import Fastify, { type FastifyInstance } from 'fastify';
import { extractFromHtml } from './extract.js';
import { crawl, fetchPageHtml } from './crawl.js';
import { toMarkdown } from './markdown.js';
import { listProviders, resolveProvider } from './providers/index.js';
import {
  fetchFeed,
  fetchTranscript,
  probeReach,
  reachProviderSummary,
} from './providers/reach.js';
import { isNetworkDisabled, searchWeb } from './search.js';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 17322;

interface ExtractBody {
  url?: string;
  html?: string;
  /** Optional provider name; falls back to the built-in crawler when unset. */
  provider?: string;
}

interface CrawlBody {
  url?: string;
  depth?: number;
  maxPages?: number;
  /** Optional provider name; falls back to the built-in crawler when unset. */
  provider?: string;
}

interface MarkdownBody {
  base64?: string;
  filename?: string;
}

interface SearchQuery {
  q?: string;
}

interface TranscriptQuery {
  url?: string;
  lang?: string;
}

interface FeedQuery {
  url?: string;
  max?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether a query value is an absolute `http(s)` URL. */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate an optional positive-integer query parameter. Returns the fallback
 * when absent, the parsed integer when valid, or `undefined` when the value is
 * present but malformed/out of range (which the caller turns into a 400).
 */
function parseBoundedInt(value: unknown, fallback: number, upper: number): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > upper) return undefined;
  return parsed;
}

/**
 * Build the Fastify instance for the local crawler/research service.
 * Exposed separately from {@link startServer} so it can be driven by
 * `fastify.inject()` in tests without opening a socket.
 */
export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/health', async () => ({
    status: 'ok',
    service: '@diggy/crawler',
    providers: listProviders(),
    reach: reachProviderSummary(),
  }));

  app.get('/providers', async () => ({
    providers: listProviders(),
    reach: reachProviderSummary(),
  }));

  app.post<{ Body: ExtractBody }>('/extract', async (request, reply) => {
    const body = request.body ?? {};
    const html = typeof body.html === 'string' ? body.html : undefined;
    const url = typeof body.url === 'string' ? body.url : undefined;

    if (html && html.trim()) {
      return extractFromHtml(html, url);
    }

    if (url && url.trim()) {
      const provider = resolveProvider(body.provider);
      try {
        if (typeof provider.extract === 'function') {
          const result = await provider.extract(url);
          return { ...result, provider: provider.name };
        }
        const fetched = await fetchPageHtml(url);
        return { ...extractFromHtml(fetched, url), provider: 'builtin' };
      } catch (error) {
        reply.code(502);
        return { error: `Failed to fetch ${url}: ${messageOf(error)}` };
      }
    }

    reply.code(400);
    return { error: 'Request body must include either "html" or "url".' };
  });

  app.post<{ Body: CrawlBody }>('/crawl', async (request, reply) => {
    const body = request.body ?? {};
    if (typeof body.url !== 'string' || !body.url.trim()) {
      reply.code(400);
      return { error: 'Request body must include a "url".' };
    }

    const provider = resolveProvider(body.provider);
    try {
      const results = await provider.crawl({
        url: body.url,
        depth: body.depth,
        maxPages: body.maxPages,
      });
      return { results, provider: provider.name };
    } catch (error) {
      reply.code(502);
      return { error: `Crawl failed: ${messageOf(error)}` };
    }
  });

  app.post<{ Body: MarkdownBody }>('/markdown', async (request, reply) => {
    const body = request.body ?? {};
    if (typeof body.base64 !== 'string' || !body.base64) {
      reply.code(400);
      return { error: 'Request body must include base64-encoded "base64" content.' };
    }

    try {
      const markdown = await toMarkdown({
        base64: body.base64,
        filename: body.filename ?? 'document.txt',
      });
      return { markdown };
    } catch (error) {
      reply.code(422);
      return { error: `Failed to convert document: ${messageOf(error)}` };
    }
  });

  app.get<{ Querystring: SearchQuery }>('/search', async (request, reply) => {
    const query = typeof request.query.q === 'string' ? request.query.q.trim() : '';
    if (!query) {
      reply.code(400);
      return { error: 'Query parameter "q" is required.' };
    }

    try {
      const results = await searchWeb(query);
      return { query, results, offline: isNetworkDisabled() };
    } catch (error) {
      reply.code(502);
      return { error: `Search failed: ${messageOf(error)}` };
    }
  });

  // ── reach capability layer ──────────────────────────────────────────────

  app.get<{ Querystring: TranscriptQuery }>('/transcript', async (request, reply) => {
    const url = typeof request.query.url === 'string' ? request.query.url.trim() : '';
    if (!url || !isHttpUrl(url)) {
      reply.code(400);
      return { error: 'Query parameter "url" must be a valid http(s) URL.' };
    }
    const lang =
      typeof request.query.lang === 'string' && request.query.lang.trim().length > 0
        ? request.query.lang.trim()
        : 'en';

    if (isNetworkDisabled()) {
      return { url, language: lang, text: '', source: 'yt-dlp', offline: true };
    }

    try {
      const transcript = await fetchTranscript(url, { lang });
      if (!transcript) {
        reply.code(502);
        return { error: `Failed to fetch a transcript for ${url}.` };
      }
      return {
        ...(transcript.title ? { title: transcript.title } : {}),
        language: transcript.language ?? lang,
        text: transcript.text,
        source: 'yt-dlp',
      };
    } catch (error) {
      reply.code(502);
      return { error: `Failed to fetch a transcript for ${url}: ${messageOf(error)}` };
    }
  });

  app.get<{ Querystring: FeedQuery }>('/feed', async (request, reply) => {
    const url = typeof request.query.url === 'string' ? request.query.url.trim() : '';
    if (!url || !isHttpUrl(url)) {
      reply.code(400);
      return { error: 'Query parameter "url" must be a valid http(s) URL.' };
    }
    const max = parseBoundedInt(request.query.max, 10, 100);
    if (max === undefined) {
      reply.code(400);
      return { error: 'Query parameter "max" must be an integer between 1 and 100.' };
    }

    if (isNetworkDisabled()) {
      return { url, max, items: [], offline: true };
    }

    try {
      const feed = await fetchFeed(url, { max });
      if (!feed) {
        reply.code(502);
        return { error: `Failed to fetch the feed at ${url}.` };
      }
      return { ...(feed.title ? { title: feed.title } : {}), items: feed.items };
    } catch (error) {
      reply.code(502);
      return { error: `Failed to fetch the feed at ${url}: ${messageOf(error)}` };
    }
  });

  app.get('/reach', async () => {
    const probe = await probeReach();
    return probe;
  });

  return app;
}

/**
 * Start the crawler service. Binds **127.0.0.1 only** — it is never exposed on
 * a public interface.
 */
export async function startServer(port: number = DEFAULT_PORT): Promise<FastifyInstance> {
  const app = buildServer();
  await app.listen({ port, host: HOST });
  return app;
}

export { DEFAULT_PORT, HOST };
