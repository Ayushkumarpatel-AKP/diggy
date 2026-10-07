/**
 * Sensitive-site blocklist.
 *
 * Banks, payment pages, password managers and health portals are **deny by
 * default** — for reads *and* for actions. Reading a bank statement into the
 * model is exactly as dangerous as acting on it, so the rule is symmetric.
 *
 * A user can override the default for a specific host via the per-site allow
 * list (`{ allowlist: ['chase.com'] }`), which is the only escape hatch.
 * Nothing here throws on garbage input.
 */

/** The kinds of sensitive site. */
export type SensitiveCategory = 'bank' | 'payment' | 'password-manager' | 'health';

/** A blocklist rule: host suffixes, host substrings, and URL keywords. */
export interface SensitiveSiteRule {
  category: SensitiveCategory;
  /** Exact host or registrable suffix (matches `host` and `*.host`). */
  hosts?: readonly string[];
  /** Substrings matched against the hostname (for wildcard portals). */
  hostContains?: readonly string[];
  /** Substrings matched against the lowercased full URL (path/query signals). */
  keywords?: readonly string[];
}

/**
 * The default blocklist. Hosts are compared case-insensitively as suffixes, so
 * `chase.com` also covers `www.chase.com` and `secure.chase.com`.
 */
export const SENSITIVE_SITE_RULES: readonly SensitiveSiteRule[] = [
  {
    category: 'bank',
    hosts: [
      'chase.com',
      'bankofamerica.com',
      'wellsfargo.com',
      'citibank.com',
      'citi.com',
      'capitalone.com',
      'usbank.com',
      'pnc.com',
      'td.com',
      'tdbank.com',
      'hsbc.com',
      'hsbc.co.uk',
      'barclays.co.uk',
      'lloydsbank.com',
      'natwest.com',
      'santander.com',
      'santander.co.uk',
      'nationwide.co.uk',
      'monzo.com',
      'starlingbank.com',
      'revolut.com',
      'hdfcbank.com',
      'icicibank.com',
      'axisbank.com',
      'kotak.com',
      'sbi.co.in',
      'onlinesbi.sbi',
      'sbicard.com',
      'idfcbank.com',
      'indusind.com',
      'yesbank.in',
      'bankofbaroda.in',
      'bobibanking.com',
      'pnbindia.in',
      'canarabank.com',
      'unionbankofindia.co.in',
      'federalbank.co.in',
      'rblbank.com',
      'firstdirect.com',
      'halifax.co.uk',
      'schwab.com',
      'fidelity.com',
      'vanguard.com',
    ],
    keywords: ['/netbanking', '/net-banking', '/online-banking', '/ibanking', '/onlinebanking'],
  },
  {
    category: 'payment',
    hosts: [
      'paypal.com',
      'stripe.com',
      'squareup.com',
      'square.com',
      'razorpay.com',
      'paytm.com',
      'phonepe.com',
      'venmo.com',
      'cash.app',
      'wise.com',
      'checkout.com',
      'coinbase.com',
      'binance.com',
      'kraken.com',
      'moonpay.com',
      'adyen.com',
      'braintreepayments.com',
      'klarna.com',
      'afterpay.com',
      'affirm.com',
      'gumroad.com',
    ],
    keywords: ['/checkout', '/payment', '/billing', '/purchase', '/wallet', '/subscribe', '/billingdetails'],
  },
  {
    category: 'password-manager',
    hosts: [
      '1password.com',
      '1password.eu',
      '1password.ca',
      'lastpass.com',
      'bitwarden.com',
      'dashlane.com',
      'nordpass.com',
      'keeper.com',
      'keepersecurity.com',
      'enpass.io',
      'keepass.info',
      'roboform.com',
      'proton.me',
    ],
    hostContains: ['password-manager', 'passwordmanager'],
    keywords: ['/passwords', '/password-manager', '/vault'],
  },
  {
    category: 'health',
    hosts: [
      'mychart.com',
      'mychart.org',
      'kp.org',
      'kaiserpermanente.org',
      'cerner.com',
      'epic.com',
    ],
    hostContains: ['mychart', 'patientportal', 'patient-portal', 'myhealth', 'healthportal'],
    keywords: ['/medical-records', '/health-records', '/prescriptions', '/patient-portal'],
  },
];

/** Options for {@link sensitiveSiteCategory} / {@link isSensitiveSite}. */
export interface SensitiveSiteOptions {
  /** Hosts or URLs the user has explicitly approved (their allow list). */
  allowlist?: readonly string[];
}

function coerceUrl(url: unknown): string {
  if (typeof url === 'string') return url.trim();
  return '';
}

/**
 * Extract a lowercase hostname from a URL or bare host. Returns `null` for
 * anything it cannot make sense of. Never throws.
 */
export function normalizeHost(url: unknown): string | null {
  const raw = coerceUrl(url);
  if (raw === '') return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withScheme);
    const host = parsed.hostname.toLowerCase().replace(/^\.+|\.+$/g, '');
    return host === '' ? null : host;
  } catch {
    // Manual fallback: strip scheme/userinfo/port/path.
    const withoutScheme = raw.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    const authority = (withoutScheme.split(/[/?#]/)[0] ?? '').split('@').pop() ?? '';
    const host = (authority.split(':')[0] ?? '').replace(/^www\./, '').replace(/^\.+|\.+$/g, '');
    return host === '' ? null : host;
  }
}

/** Is the host (or its parent) present in the user's allow list? */
export function isSiteAllowlisted(url: unknown, allowlist?: readonly string[]): boolean {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return false;
  const host = normalizeHost(url);
  if (host === null) return false;
  for (const entry of allowlist) {
    const normalized = normalizeHost(entry);
    if (normalized === null || normalized === '') continue;
    if (host === normalized || host.endsWith(`.${normalized}`)) return true;
  }
  return false;
}

function hostSuffixMatch(host: string, suffix: string): boolean {
  const s = suffix.toLowerCase();
  return host === s || host.endsWith(`.${s}`);
}

/**
 * The sensitive category a URL falls into, or `null` when it is fine.
 * Returns `null` for an allow-listed site, so an explicit user override wins.
 */
export function sensitiveSiteCategory(
  url: unknown,
  options?: SensitiveSiteOptions,
): SensitiveCategory | null {
  const raw = coerceUrl(url);
  if (raw === '') return null;
  if (isSiteAllowlisted(url, options?.allowlist)) return null;

  const host = normalizeHost(url);
  const lower = raw.toLowerCase();

  for (const rule of SENSITIVE_SITE_RULES) {
    if (host !== null && rule.hosts) {
      for (const h of rule.hosts) {
        if (hostSuffixMatch(host, h)) return rule.category;
      }
    }
    if (host !== null && rule.hostContains) {
      for (const c of rule.hostContains) {
        if (host.includes(c.toLowerCase())) return rule.category;
      }
    }
    if (rule.keywords) {
      for (const k of rule.keywords) {
        if (lower.includes(k.toLowerCase())) return rule.category;
      }
    }
  }
  return null;
}

/** Convenience predicate over {@link sensitiveSiteCategory}. */
export function isSensitiveSite(url: unknown, options?: SensitiveSiteOptions): boolean {
  return sensitiveSiteCategory(url, options) !== null;
}
