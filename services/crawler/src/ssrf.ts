/**
 * SSRF guard for the crawler's URL-accepting routes.
 *
 * A hostile page (or a hostile `DIGGY_TOKEN` holder) can otherwise ask the
 * crawler to fetch `http://169.254.169.254/…` (cloud metadata),
 * `http://127.0.0.1:…` (other local services) or a private RFC1918 host. This
 * module only permits `http`/`https`, resolves the hostname and rejects any
 * address that is loopback, private, link-local, CGNAT, unique-local IPv6 or a
 * known cloud-metadata endpoint.
 *
 * It also exposes {@link safeFetchText}, a small fetch primitive that enforces
 * the redirect, response-size and wall-clock caps used by every guarded read.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Maximum redirect hops followed before giving up. */
export const MAX_REDIRECTS = 5;

/** Maximum response body size accepted (5 MB). */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** Total wall-clock budget for a guarded fetch or crawl (20 s). */
export const TOTAL_TIMEOUT_MS = 20_000;

/** Result of {@link checkUrl}: either the parsed URL or a rejection reason. */
export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** Error thrown by {@link safeFetchText} when a URL is refused. */
export class BlockedUrlError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'BlockedUrlError';
  }
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number.parseInt(part, 10);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function inRange(value: number, base: string, prefix: number): boolean {
  const baseValue = ipv4ToInt(base);
  if (baseValue === null || prefix <= 0 || prefix > 32) return false;
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

/** True when an IPv4 literal is loopback/private/link-local/CGNAT/reserved. */
export function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true; // Unparseable → fail closed.

  const ranges: Array<[string, number]> = [
    ['0.0.0.0', 8], // "this network"
    ['10.0.0.0', 8], // private
    ['100.64.0.0', 10], // CGNAT
    ['127.0.0.0', 8], // loopback
    ['169.254.0.0', 16], // link-local (includes 169.254.169.254 metadata)
    ['172.16.0.0', 12], // private
    ['192.0.0.0', 24], // IETF protocol assignments
    ['192.0.2.0', 24], // TEST-NET-1
    ['192.168.0.0', 16], // private
    ['198.18.0.0', 15], // benchmarking
    ['198.51.100.0', 24], // TEST-NET-2
    ['203.0.113.0', 24], // TEST-NET-3
    ['224.0.0.0', 4], // multicast
    ['240.0.0.0', 4], // reserved
  ];

  return ranges.some(([base, prefix]) => inRange(value, base, prefix));
}

/** True when an IPv6 literal is loopback/link-local/unique-local/metadata. */
export function isBlockedIpv6(input: string): boolean {
  let ip = input.toLowerCase();
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);

  // IPv4-mapped (`::ffff:a.b.c.d`) and IPv4-compatible (`::a.b.c.d`) forms.
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(ip);
  if (dotted && (ip.startsWith('::ffff:') || ip.startsWith('::'))) {
    return isBlockedIpv4(dotted[1] as string);
  }

  // IPv4-mapped in hex (`::ffff:7f00:1`).
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (hexMapped) {
    const high = Number.parseInt(hexMapped[1] as string, 16);
    const low = Number.parseInt(hexMapped[2] as string, 16);
    return isBlockedIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }

  if (ip === '::' || ip === '::1') return true; // unspecified / loopback
  if (/^f[cd][0-9a-f]{0,2}:/.test(ip)) return true; // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]{0,2}:/.test(ip)) return true; // fe80::/10 link-local
  if (/^ff[0-9a-f]{0,2}:/.test(ip)) return true; // ff00::/8 multicast
  if (ip.startsWith('::ffff:')) return true; // any other mapped form → refuse
  return false;
}

/** True when `ip` (v4 or v6) must not be fetched. Unknown input → blocked. */
export function isBlockedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) return isBlockedIpv6(ip);
  return true;
}

/** Strip the brackets Node keeps on an IPv6 URL hostname. */
function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '');
}

/**
 * Validate a URL for outbound fetching.
 *
 * Rejects anything that is not `http`/`https`, any hostname that resolves to a
 * blocked address, and any literal blocked address. Returns the parsed URL on
 * success or a machine-readable reason on rejection.
 */
export async function checkUrl(raw: string): Promise<UrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `unsupported_scheme:${url.protocol.replace(':', '')}` };
  }

  const host = hostnameOf(url);
  if (isIP(host)) {
    return isBlockedIp(host)
      ? { ok: false, reason: `blocked_address:${host}` }
      : { ok: true, url };
  }

  let addresses: string[];
  try {
    const results = await lookup(host, { all: true });
    addresses = results.map((entry) => entry.address);
  } catch {
    return { ok: false, reason: `dns_lookup_failed:${host}` };
  }

  if (addresses.length === 0) {
    return { ok: false, reason: `dns_lookup_failed:${host}` };
  }

  const blocked = addresses.find((address) => isBlockedIp(address));
  if (blocked) {
    return { ok: false, reason: `blocked_address:${blocked}` };
  }

  return { ok: true, url };
}

/** Options for {@link safeFetchText}. */
export interface SafeFetchOptions {
  /** Injectable fetch (tests); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Override the redirect cap (default {@link MAX_REDIRECTS}). */
  maxRedirects?: number;
  /** Override the response-size cap (default {@link MAX_RESPONSE_BYTES}). */
  maxBytes?: number;
  /** Override the total time budget (default {@link TOTAL_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Request headers. */
  headers?: Record<string, string>;
}

/** A guarded fetch result. */
export interface SafeFetchResult {
  url: string;
  status: number;
  text: string;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`response_too_large:${declared}`);
  }

  const body = response.body;
  if (!body) return response.text();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`response_too_large:>${maxBytes}`);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Fetch a URL with every SSRF cap applied: each hop is re-validated with
 * {@link checkUrl}, redirects are followed manually up to `maxRedirects`, the
 * body is capped at `maxBytes` and the whole request aborts after `timeoutMs`.
 *
 * Throws {@link BlockedUrlError} for a refused URL (or too many redirects) and
 * a plain `Error` for a size overrun.
 */
export async function safeFetchText(
  raw: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TOTAL_TIMEOUT_MS);
  try {
    let current = raw;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const check = await checkUrl(current);
      if (!check.ok) throw new BlockedUrlError(check.reason);

      const response = await fetchImpl(check.url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: options.headers ?? { accept: 'text/html,application/xhtml+xml' },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location) return { url: current, status: response.status, text: '' };
        current = new URL(location, check.url).toString();
        continue;
      }

      const text = await readCapped(response, maxBytes);
      return { url: current, status: response.status, text };
    }

    throw new BlockedUrlError('too_many_redirects');
  } finally {
    clearTimeout(timer);
  }
}
