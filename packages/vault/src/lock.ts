/**
 * @diggy/vault — lock / unlock lifecycle.
 *
 * `VaultLock` owns the in-memory decrypted profile and the derived AES key.
 * It loads + decrypts a blob on `unlock`, re-encrypts on `setProfile`, and
 * auto-locks after a configurable period of inactivity.
 *
 * Security notes:
 *  - The derived key is held only as a non-extractable `CryptoKey` in memory and is
 *    never handed to a `StorageAdapter` (which only ever sees ciphertext).
 *  - `getProfile()` returns the profile *without* the `secrets` section. Reading
 *    secrets requires an explicit `{ includeSecrets: true }` flag via `getSecrets()`.
 */
import type { Profile, Secrets } from '@diggy/shared';
import {
  base64ToBytes,
  decryptWithKey,
  deriveAesKey,
  encryptJson,
  encryptWithKey,
  type EncryptedBlob,
  type KdfParams,
} from './crypto';
import { parseProfile, stripSecrets, type ProfileWithoutSecrets } from './profile.schema';
import type { StorageAdapter } from './store';

/** Base class for all vault errors. */
export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

/** Thrown when an operation requires an unlocked vault. */
export class VaultLockedError extends VaultError {
  constructor(message = 'Vault is locked') {
    super(message);
    this.name = 'VaultLockedError';
  }
}

/** Thrown when no encrypted blob exists for the requested vault id. */
export class VaultNotFoundError extends VaultError {
  constructor(message = 'No vault found') {
    super(message);
    this.name = 'VaultNotFoundError';
  }
}

export interface VaultLockOptions {
  /** Minutes of inactivity before the vault auto-locks. `<= 0` disables auto-lock. Default: 15. */
  autoLockMinutes?: number;
  /** Storage key for this vault. Default: `"profile"`. */
  vaultId?: string;
  /** Invoked whenever the vault transitions from unlocked to locked. */
  onLock?: () => void;
}

export const DEFAULT_AUTO_LOCK_MINUTES = 15;
const DEFAULT_VAULT_ID = 'profile';

export class VaultLock {
  private readonly store: StorageAdapter;
  private readonly autoLockMinutes: number;
  private readonly vaultId: string;
  private readonly onLock: (() => void) | undefined;

  // In-memory-only session state.
  private key: CryptoKey | null = null;
  private salt: Uint8Array | null = null;
  private kdfParams: KdfParams | null = null;
  private profile: Profile | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(store: StorageAdapter, options: VaultLockOptions = {}) {
    this.store = store;
    this.autoLockMinutes = options.autoLockMinutes ?? DEFAULT_AUTO_LOCK_MINUTES;
    this.vaultId = options.vaultId ?? DEFAULT_VAULT_ID;
    this.onLock = options.onLock;
  }

  /** Whether the vault is currently unlocked (key present in memory). */
  get isUnlocked(): boolean {
    return this.key !== null;
  }

  /** The storage id this vault is persisted under. */
  get id(): string {
    return this.vaultId;
  }

  /**
   * Loads the encrypted blob and decrypts it with `passphrase`.
   * Throws `VaultNotFoundError` if no blob exists, and rejects (AES-GCM auth
   * failure) if the passphrase is wrong. On failure the vault stays locked.
   */
  async unlock(passphrase: string): Promise<void> {
    this.clearTimer();
    const blob = await this.store.load(this.vaultId);
    if (!blob) {
      throw new VaultNotFoundError(`No vault found for id "${this.vaultId}"`);
    }
    const salt = base64ToBytes(blob.salt);
    const key = await deriveAesKey(passphrase, salt, blob.params);
    // Decrypt first (this authenticates the passphrase) before mutating state.
    const decrypted = await decryptWithKey<unknown>(key, blob);
    this.key = key;
    this.salt = salt;
    this.kdfParams = { ...blob.params };
    this.profile = parseProfile(decrypted);
    this.scheduleAutoLock();
  }

  /** Locks the vault, wiping the in-memory key and profile. */
  lock(): void {
    const wasUnlocked = this.key !== null;
    this.key = null;
    this.salt = null;
    this.kdfParams = null;
    this.profile = null;
    this.clearTimer();
    if (wasUnlocked) {
      this.onLock?.();
    }
  }

  /** Resets the inactivity timer (call on user activity). No-op when locked. */
  touch(): void {
    if (this.key === null) return;
    this.scheduleAutoLock();
  }

  /** Stops the timer and wipes state without firing `onLock`. */
  dispose(): void {
    this.key = null;
    this.salt = null;
    this.kdfParams = null;
    this.profile = null;
    this.clearTimer();
  }

  /**
   * Returns the profile without the `secrets` section.
   * Throws `VaultLockedError` when locked.
   */
  getProfile(): ProfileWithoutSecrets {
    const { profile } = this.assertUnlocked();
    this.touch();
    return structuredClone(stripSecrets(profile));
  }

  /**
   * Returns the `secrets` section. Requires an explicit `{ includeSecrets: true }`
   * flag; anything else throws. Throws `VaultLockedError` when locked.
   */
  getSecrets(options: { includeSecrets: true }): Secrets {
    const { profile } = this.assertUnlocked();
    this.touch();
    if (!options || options.includeSecrets !== true) {
      throw new VaultError('getSecrets() requires an explicit { includeSecrets: true } flag');
    }
    return structuredClone(profile.secrets);
  }

  /** Validates + re-encrypts the profile under the existing key and persists it. */
  async setProfile(profile: Profile): Promise<void> {
    const { key, salt, params } = this.assertUnlocked();
    const normalized = parseProfile(profile);
    const blob = await encryptWithKey(key, normalized, salt, params);
    await this.store.save(this.vaultId, blob);
    this.profile = normalized;
    this.touch();
  }

  /* ---------------------------------------------------------------- */

  private assertUnlocked(): { key: CryptoKey; salt: Uint8Array; params: KdfParams; profile: Profile } {
    const { key, salt, kdfParams, profile } = this;
    if (key === null || salt === null || kdfParams === null || profile === null) {
      throw new VaultLockedError();
    }
    return { key, salt, params: kdfParams, profile };
  }

  private scheduleAutoLock(): void {
    this.clearTimer();
    const ms = this.autoLockMinutes * 60_000;
    if (!Number.isFinite(ms) || ms <= 0) return; // auto-lock disabled
    this.timer = setTimeout(() => {
      this.lock();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export interface InitializeVaultOptions {
  vaultId?: string;
  params?: Partial<KdfParams>;
}

/**
 * Creates (or overwrites) the on-disk encrypted vault for `profile`.
 * Returns the ciphertext blob that was written — handy for tests.
 */
export async function initializeVault(
  store: StorageAdapter,
  passphrase: string,
  profile: Profile,
  options: InitializeVaultOptions = {},
): Promise<EncryptedBlob> {
  const vaultId = options.vaultId ?? DEFAULT_VAULT_ID;
  const normalized = parseProfile(profile);
  const blob = await encryptJson(normalized, passphrase, options.params);
  await store.save(vaultId, blob);
  return blob;
}
