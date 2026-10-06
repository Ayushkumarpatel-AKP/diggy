import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decryptString, encryptString, signSession, verifySession } from '../src/crypto.js';

const KEY = randomBytes(32);
const SECRET = 'test-session-secret';

describe('crypto: at-rest encryption', () => {
  it('round-trips a token through AES-256-GCM', () => {
    const token = 'ya29.a0AfH6SMB-super-secret-refresh-token';
    const ciphertext = encryptString(token, KEY);
    expect(decryptString(ciphertext, KEY)).toBe(token);
  });

  it('never embeds the plaintext token in the ciphertext', () => {
    const token = 'gho_abcdefghijklmnopqrstuvwxyz012345';
    const ciphertext = encryptString(token, KEY);
    expect(ciphertext).not.toContain(token);
    expect(ciphertext).not.toContain('refresh-token');
    // Also holds for the substring-free short form.
    expect(encryptString('topsecretvalue', KEY)).not.toContain('topsecretvalue');
  });

  it('uses a fresh IV so equal inputs produce different ciphertext', () => {
    expect(encryptString('same', KEY)).not.toBe(encryptString('same', KEY));
  });

  it('rejects the wrong key', () => {
    const ciphertext = encryptString('secret', KEY);
    expect(() => decryptString(ciphertext, randomBytes(32))).toThrow();
  });

  it('rejects malformed input', () => {
    expect(() => decryptString('not-a-ciphertext', KEY)).toThrow();
  });
});

describe('crypto: session tokens', () => {
  it('signs and verifies a token', () => {
    const token = signSession('user-42', 60_000, SECRET);
    const verified = verifySession(token, SECRET);
    expect(verified?.userId).toBe('user-42');
    expect(verified?.expiresAt).toBeGreaterThan(Date.now());
  });

  it('rejects tampered, mis-signed and expired tokens', () => {
    const token = signSession('user-42', 60_000, SECRET);
    expect(verifySession(`${token}x`, SECRET)).toBeUndefined();
    expect(verifySession(token, 'a-different-secret')).toBeUndefined();
    expect(verifySession(signSession('user-42', -1_000, SECRET), SECRET)).toBeUndefined();
    expect(verifySession('garbage', SECRET)).toBeUndefined();
  });
});
