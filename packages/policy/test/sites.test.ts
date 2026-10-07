import { describe, expect, it } from 'vitest';
import {
  SENSITIVE_SITE_RULES,
  isSensitiveSite,
  isSiteAllowlisted,
  normalizeHost,
  sensitiveSiteCategory,
} from '../src/index';

describe('isSensitiveSite (default deny)', () => {
  it('blocks banks for reads and actions', () => {
    expect(isSensitiveSite('https://www.chase.com/accounts')).toBe(true);
    expect(sensitiveSiteCategory('https://www.chase.com/accounts')).toBe('bank');
    expect(isSensitiveSite('https://netbanking.hdfcbank.com/')).toBe(true);
    expect(isSensitiveSite('https://onlinesbi.sbi/')).toBe(true);
    expect(isSensitiveSite('https://example.com/netbanking/login')).toBe(true); // keyword
  });

  it('blocks payment pages', () => {
    expect(sensitiveSiteCategory('https://www.paypal.com/checkout')).toBe('payment');
    expect(isSensitiveSite('https://checkout.stripe.com/pay')).toBe(true);
    expect(isSensitiveSite('https://shop.example.com/checkout')).toBe(true); // keyword
    expect(isSensitiveSite('https://www.razorpay.com/pay')).toBe(true);
  });

  it('blocks password managers', () => {
    expect(sensitiveSiteCategory('https://my.1password.com/')).toBe('password-manager');
    expect(isSensitiveSite('https://vault.bitwarden.com/')).toBe(true);
    expect(isSensitiveSite('https://lastpass.com/')).toBe(true);
  });

  it('blocks health portals (including wildcard patient portals)', () => {
    expect(sensitiveSiteCategory('https://mychart.example-hospital.org/')).toBe('health');
    expect(isSensitiveSite('https://kp.org/')).toBe(true);
    expect(isSensitiveSite('https://hospital.example.com/patient-portal')).toBe(true);
  });

  it('leaves ordinary sites alone', () => {
    expect(isSensitiveSite('https://example.com')).toBe(false);
    expect(isSensitiveSite('https://github.com/user/repo')).toBe(false);
    expect(isSensitiveSite('https://news.ycombinator.com/')).toBe(false);
  });

  it('a per-site allow entry overrides the default (host and subdomains)', () => {
    expect(isSensitiveSite('https://www.chase.com/accounts', { allowlist: ['chase.com'] })).toBe(false);
    expect(isSensitiveSite('https://www.chase.com/accounts', { allowlist: ['https://chase.com'] })).toBe(false);
    expect(isSiteAllowlisted('https://secure.chase.com', ['chase.com'])).toBe(true);
    expect(isSiteAllowlisted('https://other.com', ['chase.com'])).toBe(false);
    // allow list does not leak to unrelated hosts
    expect(isSensitiveSite('https://paypal.com', { allowlist: ['chase.com'] })).toBe(true);
  });

  it('every rule has a known category', () => {
    for (const rule of SENSITIVE_SITE_RULES) {
      expect(['bank', 'payment', 'password-manager', 'health']).toContain(rule.category);
    }
  });

  it('never throws on garbage URLs', () => {
    expect(isSensitiveSite(undefined)).toBe(false);
    expect(isSensitiveSite(null)).toBe(false);
    expect(isSensitiveSite(123)).toBe(false);
    expect(isSensitiveSite('not a url at all')).toBe(false);
    expect(() => normalizeHost({})).not.toThrow();
    expect(normalizeHost('')).toBeNull();
  });
});
