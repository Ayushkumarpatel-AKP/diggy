/**
 * Jina Reader fallback gate.
 *
 * Diggy's last-resort reader proxies arbitrary URLs through `https://r.jina.ai/`.
 * That is an outbound request carrying whatever the page asked for, so it is
 * **off by default** and only enabled with `DIGGY_JINA=1` (the extension will
 * eventually pass its own toggle). Even when enabled, only "safe" public URLs
 * are accepted: no private hosts, no credentials in the URL (`user:pass@`), no
 * token-like query parameters and nothing on the user's `~/.diggy/owned-sites.txt`
 * list.
 */
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';

import { diggyHomeDir } from '@diggy/shared/service-auth';

import { isBlockedIp } from './ssrf.js';

/** Environment variable that turns the Jina Reader fallback on. */
export const JINA_ENV = 'DIGGY_JINA';

/** Query-parameter names that usually carry a secret. */
const SENSITIVE_PARAM_WORDS = [
  'token',
  'key',
  'sig',
  'signature',
  'auth',
  'session',
  'password',
  'secret',
] as const;

/** Whether the Jina Reader fallback is enabled for this environment. */
export function isJinaEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env[JINA_ENV]?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

/** Absolute path of the user's owned-sites list (`~/.diggy/owned-sites.txt`). */
export function ownedSitesPath(): string {
  return join(diggyHomeDir(), 'owned-sites.txt');
}

/** Normalise one owned-sites entry to a bare lowercase hostname. */
function normalizeOwnedEntry(entry: string): string {
  let value = entry.trim().toLowerCase();
  if (!value) return '';
  if (value.includes('://')) {
    try {
      value = new URL(value).hostname;
    } catch {
      /* fall through with the raw value */
    }
  }
  const slash = value.indexOf('/');
  if (slash >= 0) value = value.slice(0, slash);
  const colon = value.indexOf(':');
  if (colon >= 0) value = value.slice(0, colon);
  return value.replace(/^\.+|\.+$/g, '');
}

/**
 * Read the owned-sites list. Comment (`#`) and blank lines are ignored and a
 * missing file yields `[]` — the list is opt-in.
 */
export function loadOwnedSites(filePath: string = ownedSitesPath()): string[] {
  try {
    return readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map(normalizeOwnedEntry)
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/** True when `host` is a local/private name a public proxy must never read. */
export function isPrivateHostname(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (value === 'localhost') return true;
  return (
    value.endsWith('.localhost') ||
    value.endsWith('.local') ||
    value.endsWith('.internal') ||
    value === 'metadata.google.internal'
  );
}

/** True when the query-parameter name looks like it carries a secret. */
export function isSensitiveParam(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_PARAM_WORDS.some((word) => normalized.includes(word));
}

/** Result of {@link isJinaEligible}. */
export type JinaCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** Options for {@link isJinaEligible}. */
export interface JinaCheckOptions {
  /** Override the owned-sites list (tests). */
  ownedSites?: readonly string[];
}

/**
 * Decide whether a URL may be sent to the Jina Reader. Pure and synchronous —
 * DNS-level private hosts are additionally rejected by the caller's SSRF guard.
 */
export function isJinaEligible(raw: string, options: JinaCheckOptions = {}): JinaCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `unsupported_scheme:${url.protocol.replace(':', '')}` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'userinfo_not_allowed' };
  }
  for (const [name] of url.searchParams) {
    if (isSensitiveParam(name)) {
      return { ok: false, reason: `sensitive_query_param:${name}` };
    }
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host) ? isBlockedIp(host) : isPrivateHostname(host)) {
    return { ok: false, reason: `private_host:${host}` };
  }

  const owned = options.ownedSites ?? loadOwnedSites();
  if (owned.some((entry) => host === entry || host.endsWith(`.${entry}`))) {
    return { ok: false, reason: `owned_site:${host}` };
  }

  return { ok: true, url };
}
