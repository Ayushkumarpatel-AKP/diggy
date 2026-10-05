import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KDF_PARAMS,
  base64ToBytes,
  bytesToBase64,
  decryptJson,
  deriveKey,
  encryptJson,
  randomBytes,
} from '../src/crypto';
import { CHEAP_PARAMS, PII_STRINGS, TEST_PASSPHRASE, sampleProfile } from './fixtures';

describe('crypto — encrypt/decrypt', () => {
  it('round-trips a JSON-serializable object', async () => {
    const profile = sampleProfile();
    const blob = await encryptJson(profile, TEST_PASSPHRASE, CHEAP_PARAMS);

    expect(blob.version).toBe(1);
    expect(blob.kdf).toBe('argon2id');
    expect(blob.params).toEqual(CHEAP_PARAMS);
    expect(typeof blob.salt).toBe('string');
    expect(typeof blob.iv).toBe('string');
    expect(typeof blob.ciphertext).toBe('string');

    const out = await decryptJson<typeof profile>(blob, TEST_PASSPHRASE);
    expect(out).toEqual(profile);
  });

  it('rejects a wrong passphrase with an AES-GCM auth failure', async () => {
    const blob = await encryptJson(sampleProfile(), TEST_PASSPHRASE, CHEAP_PARAMS);
    await expect(decryptJson(blob, 'the wrong passphrase')).rejects.toThrow();
  });

  it('rejects a tampered ciphertext', async () => {
    const blob = await encryptJson({ a: 'secret' }, TEST_PASSPHRASE, CHEAP_PARAMS);
    const bytes = base64ToBytes(blob.ciphertext);
    bytes[0] = ((bytes[0] as number) ^ 0xff) & 0xff;
    const tampered = { ...blob, ciphertext: bytesToBase64(bytes) };
    await expect(decryptJson(tampered, TEST_PASSPHRASE)).rejects.toThrow();
  });

  it('stores no plaintext PII in the serialized blob (ciphertext at rest)', async () => {
    const blob = await encryptJson(sampleProfile(), TEST_PASSPHRASE, CHEAP_PARAMS);
    const serialized = JSON.stringify(blob);

    for (const secret of PII_STRINGS) {
      expect(serialized).not.toContain(secret);
    }
    // Paranoia: the raw passphrase must not be present either.
    expect(serialized).not.toContain(TEST_PASSPHRASE);
    // And no obvious plaintext key field.
    expect(Object.keys(blob).sort()).toEqual(['ciphertext', 'iv', 'kdf', 'params', 'salt', 'version']);
  });

  it('uses the default KDF params when none are supplied', async () => {
    const blob = await encryptJson({ a: 1 }, TEST_PASSPHRASE);
    expect(blob.params).toEqual({ ...DEFAULT_KDF_PARAMS });
    expect(blob.params.hashLength).toBe(32);
    expect(await decryptJson(blob, TEST_PASSPHRASE)).toEqual({ a: 1 });
  });
});

describe('crypto — key derivation + primitives', () => {
  it('deriveKey is deterministic for a given salt and salt-sensitive', async () => {
    const salt = randomBytes(16);
    const a = await deriveKey('pw', salt);
    const b = await deriveKey('pw', salt);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a.length).toBe(32);

    const c = await deriveKey('pw', randomBytes(16));
    expect(Array.from(a)).not.toEqual(Array.from(c));
  });

  it('randomBytes returns the requested length and varies', () => {
    const a = randomBytes(24);
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a.length).toBe(24);
    expect(Array.from(a)).not.toEqual(Array.from(randomBytes(24)));
    expect(() => randomBytes(-1)).toThrow();
  });

  it('base64 helpers round-trip arbitrary lengths', () => {
    for (const n of [0, 1, 2, 3, 16, 37, 256]) {
      const bytes = randomBytes(n);
      expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
    }
  });
});
