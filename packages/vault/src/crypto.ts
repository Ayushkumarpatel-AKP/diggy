/**
 * @diggy/vault — crypto primitives.
 *
 * Passphrase-based encryption for the personal vault:
 *   passphrase --Argon2id--> 32-byte key material --AES-256-GCM--> ciphertext
 *
 * Works in both the browser and Node 22+ (both expose `globalThis.crypto.subtle`).
 * The derived key is *never* persisted — callers keep it in memory only (see lock.ts).
 */
import { argon2id, type IArgon2Options } from 'hash-wasm';

/** Argon2id parameters. `memoryKiB` is expressed in kibibytes (hash-wasm's `memorySize`). */
export interface KdfParams {
  iterations: number;
  memoryKiB: number;
  parallelism: number;
  hashLength: number;
}

/** Sensible, OWASP-aligned default Argon2id parameters. */
export const DEFAULT_KDF_PARAMS: Readonly<KdfParams> = {
  iterations: 3,
  memoryKiB: 65536, // 64 MiB
  parallelism: 1,
  hashLength: 32, // -> AES-256
};

/** The on-disk / at-rest representation. All binary fields are base64 strings. */
export interface EncryptedBlob {
  version: 1;
  kdf: 'argon2id';
  /** base64-encoded Argon2 salt. */
  salt: string;
  params: KdfParams;
  /** base64-encoded AES-GCM nonce (12 bytes). */
  iv: string;
  /** base64-encoded AES-GCM ciphertext (includes the 16-byte auth tag). */
  ciphertext: string;
}

const AES_GCM = 'AES-GCM';
const SALT_BYTES = 16;
const IV_BYTES = 12;
const AES_256_KEY_BYTES = 32;

/* ------------------------------------------------------------------ *
 * Environment / crypto access
 * ------------------------------------------------------------------ */

/** Returns the WebCrypto implementation, throwing if it is unavailable. */
function getCrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) {
    throw new Error('WebCrypto (globalThis.crypto.subtle) is not available in this environment');
  }
  return c;
}

function subtle(): SubtleCrypto {
  return getCrypto().subtle;
}

/**
 * WebCrypto's `BufferSource` (as typed by the TS 5.7 lib) only accepts
 * `ArrayBuffer`-backed views, while the default `Uint8Array` alias is
 * `Uint8Array<ArrayBufferLike>`. Every byte array here is ArrayBuffer-backed
 * (built from `new Uint8Array`, `getRandomValues`, or WebCrypto output), so
 * this narrowing cast is safe.
 */
function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

/* ------------------------------------------------------------------ *
 * Randomness + base64
 * ------------------------------------------------------------------ */

/** Cryptographically-secure random bytes of length `n`. */
export function randomBytes(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`randomBytes: length must be a non-negative integer, got ${String(n)}`);
  }
  const out = new Uint8Array(n);
  getCrypto().getRandomValues(out);
  return out;
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const B64_LOOKUP: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < B64_ALPHABET.length; i += 1) {
    map[B64_ALPHABET[i] as string] = i;
  }
  return map;
})();

/** Standard (padded) base64 encoding of a byte array. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1] as number;
    const c = bytes[i + 2] as number;
    out +=
      (B64_ALPHABET[a >> 2] as string) +
      (B64_ALPHABET[((a & 3) << 4) | (b >> 4)] as string) +
      (B64_ALPHABET[((b & 15) << 2) | (c >> 6)] as string) +
      (B64_ALPHABET[c & 63] as string);
  }
  const rem = bytes.length % 3;
  if (rem === 1) {
    const a = bytes[i] as number;
    out += (B64_ALPHABET[a >> 2] as string) + (B64_ALPHABET[(a & 3) << 4] as string) + '==';
  } else if (rem === 2) {
    const a = bytes[i] as number;
    const b = bytes[i + 1] as number;
    out +=
      (B64_ALPHABET[a >> 2] as string) +
      (B64_ALPHABET[((a & 3) << 4) | (b >> 4)] as string) +
      (B64_ALPHABET[(b & 15) << 2] as string) +
      '=';
  }
  return out;
}

/** Decodes standard base64 (padding and whitespace tolerated). */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let p = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const v = B64_LOOKUP[clean[i] as string];
    if (v === undefined) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[p] = (buffer >> bits) & 0xff;
      p += 1;
    }
  }
  return out.subarray(0, p);
}

/* ------------------------------------------------------------------ *
 * Key derivation (Argon2id)
 * ------------------------------------------------------------------ */

/**
 * Derives raw 32-byte key material from a passphrase + salt using Argon2id.
 * Deterministic for a given (passphrase, salt, params).
 */
export async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  params: Partial<KdfParams> = {},
): Promise<Uint8Array> {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('deriveKey: passphrase must be a non-empty string');
  }
  if (!(salt instanceof Uint8Array) || salt.length === 0) {
    throw new Error('deriveKey: salt must be a non-empty Uint8Array');
  }
  const full: KdfParams = { ...DEFAULT_KDF_PARAMS, ...params };
  const options: IArgon2Options & { outputType: 'binary' } = {
    password: passphrase,
    salt,
    iterations: full.iterations,
    parallelism: full.parallelism,
    memorySize: full.memoryKiB,
    hashLength: full.hashLength,
    outputType: 'binary',
  };
  // `outputType: 'binary'` makes hash-wasm return a Uint8Array.
  return argon2id(options);
}

/** Imports raw key material as a non-extractable AES-256-GCM WebCrypto key. */
export async function importAesKey(rawKey: Uint8Array): Promise<CryptoKey> {
  if (rawKey.length !== AES_256_KEY_BYTES) {
    throw new Error(`importAesKey: expected a ${AES_256_KEY_BYTES}-byte key, got ${rawKey.length}`);
  }
  return subtle().importKey('raw', asBufferSource(rawKey), { name: AES_GCM }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Derive + import in one step, zeroing the intermediate raw key bytes afterwards.
 * This is the helper `VaultLock` uses so the key lives only as an in-memory CryptoKey.
 */
export async function deriveAesKey(
  passphrase: string,
  salt: Uint8Array,
  params: Partial<KdfParams> = {},
): Promise<CryptoKey> {
  const raw = await deriveKey(passphrase, salt, params);
  try {
    return await importAesKey(raw);
  } finally {
    raw.fill(0);
  }
}

/* ------------------------------------------------------------------ *
 * Encrypt / decrypt
 * ------------------------------------------------------------------ */

function assertBlob(blob: EncryptedBlob): void {
  if (!blob || blob.version !== 1 || blob.kdf !== 'argon2id') {
    throw new Error('Unsupported vault blob format (expected version 1 / argon2id)');
  }
}

/** Encrypts an already-imported key + a fixed salt/params. Generates a fresh IV each call. */
export async function encryptWithKey(
  key: CryptoKey,
  obj: unknown,
  salt: Uint8Array,
  params: KdfParams,
): Promise<EncryptedBlob> {
  const json = JSON.stringify(obj);
  if (json === undefined) {
    throw new Error('encryptJson: value is not JSON-serializable');
  }
  const iv = randomBytes(IV_BYTES);
  const plaintext = new TextEncoder().encode(json);
  const ciphertext = await subtle().encrypt(
    { name: AES_GCM, iv: asBufferSource(iv) },
    key,
    asBufferSource(plaintext),
  );
  return {
    version: 1,
    kdf: 'argon2id',
    salt: bytesToBase64(salt),
    params: { ...params },
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

/**
 * Decrypts with an already-imported key.
 * A wrong passphrase produces a key that fails AES-GCM authentication — the thrown
 * error propagates (it is deliberately NOT swallowed).
 */
export async function decryptWithKey<T = unknown>(key: CryptoKey, blob: EncryptedBlob): Promise<T> {
  assertBlob(blob);
  const iv = base64ToBytes(blob.iv);
  const ciphertext = base64ToBytes(blob.ciphertext);
  const plaintext = await subtle().decrypt(
    { name: AES_GCM, iv: asBufferSource(iv) },
    key,
    asBufferSource(ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

/** Encrypts any JSON-serializable value under a passphrase. Generates a fresh salt + IV. */
export async function encryptJson(
  obj: unknown,
  passphrase: string,
  params: Partial<KdfParams> = {},
): Promise<EncryptedBlob> {
  const salt = randomBytes(SALT_BYTES);
  const full: KdfParams = { ...DEFAULT_KDF_PARAMS, ...params };
  const key = await deriveAesKey(passphrase, salt, full);
  return encryptWithKey(key, obj, salt, full);
}

/**
 * Decrypts a blob with a passphrase.
 * Rejects (AES-GCM auth failure) when the passphrase is wrong.
 */
export async function decryptJson<T = unknown>(
  blob: EncryptedBlob,
  passphrase: string,
): Promise<T> {
  assertBlob(blob);
  const salt = base64ToBytes(blob.salt);
  const key = await deriveAesKey(passphrase, salt, blob.params);
  return decryptWithKey<T>(key, blob);
}
