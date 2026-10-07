/**
 * Per-install authentication + request hardening shared by the local Diggy
 * services (`@diggy/api` and `@diggy/crawler`).
 *
 * The services only ever bind to `127.0.0.1`, but a hostile web page can still
 * reach them: DNS rebinding defeats "it's localhost", browsers send an `Origin`
 * for cross-site calls, and any local process can open a socket. This module
 * gives every service the same three defences:
 *
 * 1. **A per-install bearer token** (`x-diggy-token`). It is read from the
 *    `DIGGY_TOKEN` environment variable or `~/.diggy/token` (created with mode
 *    `0600` on first use) and compared in constant time.
 * 2. **Host header validation** — the request `Host` must name loopback *and*
 *    the service's own port, which defeats DNS-rebinding via a hostile hostname.
 * 3. **Origin validation** — only the browser extension
 *    (`chrome-extension://<id>`) or a non-browser client (no `Origin`) is
 *    accepted; everything else is rejected. POST bodies must be JSON.
 *
 * Only `GET /health` is exempt from the token so liveness probes keep working.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Environment variable that overrides the on-disk token. */
export const TOKEN_ENV = 'DIGGY_TOKEN';

/** Request header every service expects to carry the token. */
export const TOKEN_HEADER = 'x-diggy-token';

/** Paths that never require the token (liveness only). */
export const TOKEN_EXEMPT_PATHS: ReadonlySet<string> = new Set(['/health']);

/** Hostnames accepted in the `Host` header. */
export const ALLOWED_HOSTNAMES: readonly string[] = ['127.0.0.1', 'localhost'];

/** Directory holding Diggy's per-user state (`~/.diggy`). */
export function diggyHomeDir(): string {
  return join(homedir(), '.diggy');
}

/** Absolute path of the per-install token file (`~/.diggy/token`). */
export function serviceTokenPath(): string {
  return join(diggyHomeDir(), 'token');
}

type Env = Record<string, string | undefined>;

/**
 * Resolve the per-install service token.
 *
 * 1. `DIGGY_TOKEN` (trimmed) when it is set.
 * 2. `~/.diggy/token` when the file exists and is non-empty.
 * 3. Otherwise generate 32 random bytes (hex) and persist them to
 *    `~/.diggy/token` with mode `0600`.
 */
export function loadServiceToken(env: Env = process.env): string {
  const fromEnv = env[TOKEN_ENV]?.trim();
  if (fromEnv) return fromEnv;

  const path = serviceTokenPath();
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // Missing/unreadable token file — fall through and generate one.
  }

  const token = randomBytes(32).toString('hex');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

/**
 * Constant-time comparison of two tokens. Returns `false` for any non-string
 * input or a length mismatch — `crypto.timingSafeEqual` throws on unequal
 * lengths, so the length check happens first.
 */
export function tokensMatch(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** The slice of a Fastify request this module needs (kept dependency-free). */
export interface AuthRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

/** The slice of a Fastify reply this module needs (kept dependency-free). */
export interface AuthReply {
  code(statusCode: number): AuthReply;
  send(payload?: unknown): unknown;
}

/**
 * Enforce the per-install token. Returns `true` when the request carries a
 * valid `x-diggy-token`; otherwise replies `401 {error:'unauthorized'}` and
 * returns `false`.
 */
export function requireToken(req: AuthRequest, reply: AuthReply, expected?: string): boolean {
  const provided = headerValue(req.headers[TOKEN_HEADER]);
  const wanted = expected ?? loadServiceToken();
  if (typeof provided === 'string' && tokensMatch(provided, wanted)) return true;

  reply.code(401).send({ error: 'unauthorized' });
  return false;
}

/** First value of a possibly-array header. */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * True when `hostHeader` names loopback on exactly `port`.
 *
 * The port must be present and equal to the service's own port; a bare
 * `localhost` (implicit port) or any other hostname/port is rejected. IPv6
 * literals are intentionally rejected because the services bind IPv4 loopback.
 */
export function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
  if (typeof hostHeader !== 'string') return false;
  const host = hostHeader.trim();
  if (!host) return false;

  let hostname: string;
  let portPart: string | undefined;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end === -1) return false;
    hostname = host.slice(1, end);
    const rest = host.slice(end + 1);
    portPart = rest.startsWith(':') ? rest.slice(1) : undefined;
  } else {
    const idx = host.lastIndexOf(':');
    if (idx === -1) {
      hostname = host;
      portPart = undefined;
    } else {
      hostname = host.slice(0, idx);
      portPart = host.slice(idx + 1);
    }
  }

  if (!ALLOWED_HOSTNAMES.includes(hostname)) return false;
  if (portPart === undefined) return false;
  return Number.parseInt(portPart, 10) === port;
}

/**
 * Origin allow-list: any `chrome-extension://<id>` origin, or a request with no
 * `Origin` header at all (non-browser clients). Everything else is rejected.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  const value = origin.trim();
  if (!value) return true;
  try {
    return new URL(value).protocol === 'chrome-extension:';
  } catch {
    return false;
  }
}

/** True for an `application/json` (optionally with parameters) content type. */
export function isJsonContentType(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  const mediaType = value.split(';')[0]?.trim().toLowerCase() ?? '';
  return mediaType === 'application/json';
}

/** Options for {@link evaluateRequest}. */
export interface GuardOptions {
  /** The service's own port (used for Host validation). */
  port: number;
  /** Expected token; defaults to {@link loadServiceToken}. */
  token?: string;
}

/** Result of the full request guard. */
export type GuardResult =
  | { ok: true }
  | { ok: false; status: number; body: { error: string; reason?: string } };

/** A tiny {@link AuthReply} that records what `requireToken` would have sent. */
class ReplyCapture implements AuthReply {
  status: number | undefined;
  body: unknown;

  code(statusCode: number): AuthReply {
    this.status = statusCode;
    return this;
  }

  send(payload?: unknown): unknown {
    this.body = payload;
    return this;
  }
}

function forbidden(reason: string): GuardResult {
  return { ok: false, status: 403, body: { error: 'forbidden', reason } };
}

/**
 * Apply the full service guard to a request: Host → Origin → token →
 * content-type. Returns `{ok:true}` when the request may proceed, otherwise the
 * status/body the caller should send.
 */
export function evaluateRequest(request: AuthRequest, options: GuardOptions): GuardResult {
  const method = (request.method ?? 'GET').toUpperCase();
  const path = (request.url ?? '/').split('?')[0] ?? '/';

  if (!isAllowedHost(headerValue(request.headers.host), options.port)) {
    return forbidden('invalid_host');
  }
  if (!isAllowedOrigin(headerValue(request.headers.origin))) {
    return forbidden('invalid_origin');
  }

  const exempt = method === 'GET' && TOKEN_EXEMPT_PATHS.has(path);
  if (!exempt) {
    const capture = new ReplyCapture();
    if (!requireToken(request, capture, options.token)) {
      return { ok: false, status: capture.status ?? 401, body: { error: 'unauthorized' } };
    }
  }

  if (method === 'POST' && !isJsonContentType(headerValue(request.headers['content-type']))) {
    return { ok: false, status: 415, body: { error: 'unsupported_media_type' } };
  }

  return { ok: true };
}
