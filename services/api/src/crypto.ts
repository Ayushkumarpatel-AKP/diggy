/**
 * Cryptography helpers.
 *
 * Two independent primitives:
 *
 *   - {@link encryptString} / {@link decryptString} — AES-256-GCM used to keep
 *     OAuth access/refresh tokens **encrypted at rest** in the database. The
 *     key comes from {@link AppConfig.tokenKey}.
 *   - {@link signSession} / {@link verifySession} — a compact, stateless HMAC
 *     session token (`base64url(payload).base64url(sig)`), so `/auth/me` and the
 *     plugin routes can authenticate without a shared table lookup.
 *
 * Both accept an optional key/secret so they can be exercised in isolation, but
 * default to the ambient {@link getContext} config.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { getContext } from './config.js';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const VERSION = 'v1';

/** Default session lifetime: 30 days. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function keyFromDefault(): Buffer {
  return getContext().config.tokenKey;
}

function secretFromDefault(): string {
  return getContext().config.sessionSecret;
}

/**
 * Encrypt a UTF-8 string. The result is self-describing and safe to store in a
 * TEXT column: `v1.<iv>.<tag>.<ciphertext>` with each part base64url-encoded.
 */
export function encryptString(plaintext: string, key: Buffer = keyFromDefault()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/** Reverse {@link encryptString}. Throws on tampering, wrong key or bad input. */
export function decryptString(payload: string, key: Buffer = keyFromDefault()): string {
  const parts = payload.split('.');
  const version = parts[0];
  const ivB64 = parts[1];
  const tagB64 = parts[2];
  const dataB64 = parts[3];
  if (parts.length !== 4 || version !== VERSION || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Malformed ciphertext');
  }
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

function hmac(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

interface SessionPayload {
  /** user id */
  u: string;
  /** expiry, epoch milliseconds */
  exp: number;
}

/**
 * Create a signed session token for `userId`. Stateless: everything needed to
 * verify it is embedded, so no storage round-trip is required.
 */
export function signSession(
  userId: string,
  ttlMs: number = SESSION_TTL_MS,
  secret: string = secretFromDefault(),
): string {
  const payload: SessionPayload = { u: userId, exp: Date.now() + ttlMs };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${hmac(encoded, secret)}`;
}

export interface VerifiedSession {
  userId: string;
  expiresAt: number;
}

/** Verify a session token's signature and expiry. Returns `undefined` if bad. */
export function verifySession(
  token: string,
  secret: string = secretFromDefault(),
): VerifiedSession | undefined {
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return undefined;
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = hmac(encoded, secret);
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
  } catch {
    return undefined;
  }
  if (typeof payload.u !== 'string' || typeof payload.exp !== 'number') return undefined;
  if (payload.exp <= Date.now()) return undefined;
  return { userId: payload.u, expiresAt: payload.exp };
}
