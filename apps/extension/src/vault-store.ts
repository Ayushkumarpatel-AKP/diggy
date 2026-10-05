/**
 * vault-store.ts — binds the encrypted `@diggy/vault` to the extension.
 *
 * A single, lazily-created `VaultLock` sits on top of an IndexedDB adapter and
 * owns the in-memory AES key + decrypted profile. This module is a *thin*
 * wrapper that:
 *   1. exposes a small promise-based API to the side panel, and
 *   2. keeps `chrome.storage.local` (`./storage`) in sync with the decrypted
 *      profile so the existing LLM `getProfile` tool keeps working.
 *
 * Security notes:
 *   - The passphrase and the derived key are NEVER persisted — they live only as
 *     in-memory session state inside `VaultLock` (the key is a non-extractable
 *     `CryptoKey`).
 *   - The plaintext cache written to `chrome.storage.local` is the profile with
 *     its `secrets` section stripped (see `stripSecrets`). Sensitive fields
 *     (govIds / PAN / bank) are only ever returned through `getSecrets(true)`.
 *   - All crypto runs here (WebCrypto + hash-wasm), i.e. in an extension page /
 *     service worker.
 */
import {
  IndexedDbAdapter,
  VaultLock,
  VaultLockedError,
  emptyProfile,
  initializeVault,
  stripSecrets,
  type StorageAdapter,
} from '@diggy/vault';
import type { Profile, Secrets } from '@diggy/shared';
import { setProfile } from './storage';

/** High-level vault state as seen by the UI. */
export type VaultStatus = 'new' | 'locked' | 'unlocked';

/** Change listener invoked with the new status on every transition. */
export type VaultChangeListener = (status: VaultStatus) => void;

/** Stable storage id for the extension's profile vault. */
const VAULT_ID = 'diggy-profile';

/** Minutes of inactivity before the vault auto-locks. */
const AUTO_LOCK_MINUTES = 15;

let adapter: StorageAdapter | null = null;
let lock: VaultLock | null = null;
const listeners = new Set<VaultChangeListener>();

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

function getAdapter(): StorageAdapter {
  if (adapter === null) adapter = new IndexedDbAdapter();
  return adapter;
}

function emit(status: VaultStatus): void {
  for (const listener of [...listeners]) {
    try {
      listener(status);
    } catch {
      /* a broken listener must never break the vault */
    }
  }
}

/** Clear the plaintext cache (used on lock / auto-lock). Best-effort. */
async function mirrorLocked(): Promise<void> {
  try {
    await setProfile(null);
  } catch {
    /* the local cache is best-effort */
  }
}

/**
 * Mirror the decrypted profile into `chrome.storage.local` for the LLM
 * `getProfile` tool — with the `secrets` section stripped so PII is never
 * exposed without an explicit confirmation. Best-effort.
 */
async function mirrorUnlocked(profile: Profile): Promise<void> {
  try {
    await setProfile({ ...stripSecrets(profile), secrets: {} });
  } catch {
    /* the local cache is best-effort */
  }
}

function getLock(): VaultLock {
  if (lock === null) {
    lock = new VaultLock(getAdapter(), {
      vaultId: VAULT_ID,
      autoLockMinutes: AUTO_LOCK_MINUTES,
      onLock: () => {
        void mirrorLocked();
        emit('locked');
      },
    });
  }
  return lock;
}

/** A full-shaped `Profile` with the `secrets` section emptied. */
function readSafeProfile(): Profile {
  const base = getLock().getProfile(); // ProfileWithoutSecrets (already cloned)
  return { ...base, secrets: {} };
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/** Whether an encrypted blob already exists for this extension. */
export async function vaultExists(): Promise<boolean> {
  const blob = await getAdapter().load(VAULT_ID);
  return blob !== undefined;
}

/** Current status: `new` (none yet), `locked` (exists but locked) or `unlocked`. */
export async function vaultStatus(): Promise<VaultStatus> {
  if (getLock().isUnlocked) return 'unlocked';
  return (await vaultExists()) ? 'locked' : 'new';
}

/**
 * Create a brand-new vault from an empty profile, then unlock it so the caller
 * can start editing immediately.
 */
export async function createVault(passphrase: string): Promise<void> {
  if (!passphrase) {
    throw new Error('A passphrase is required to create the vault.');
  }
  await initializeVault(getAdapter(), passphrase, emptyProfile(), { vaultId: VAULT_ID });
  await getLock().unlock(passphrase);
  await mirrorUnlocked(readSafeProfile());
  emit('unlocked');
}

/**
 * Decrypt the vault with `passphrase`. Rejects (AES-GCM auth failure) on a wrong
 * passphrase; on success the plaintext profile is mirrored into local storage
 * and returned (without secrets).
 */
export async function unlockVault(passphrase: string): Promise<Profile> {
  const current = getLock();
  await current.unlock(passphrase);
  const profile = readSafeProfile();
  await mirrorUnlocked(profile);
  emit('unlocked');
  return profile;
}

/** Lock the vault: wipe the in-memory key/profile and clear the local cache. */
export async function lockVault(): Promise<void> {
  getLock().lock(); // fires onLock -> mirrorLocked + emit when it was unlocked
  await mirrorLocked();
  emit('locked');
}

/** The decrypted profile (secrets removed), or `null` when the vault is locked. */
export async function getVaultProfile(): Promise<Profile | null> {
  const current = getLock();
  if (!current.isUnlocked) return null;
  try {
    return readSafeProfile();
  } catch (error) {
    if (error instanceof VaultLockedError) return null;
    throw error;
  }
}

/**
 * Validate + re-encrypt the profile and persist it. Also refreshes the plaintext
 * cache. Requires an unlocked vault.
 */
export async function saveVaultProfile(profile: Profile): Promise<void> {
  const current = getLock();
  if (!current.isUnlocked) throw new VaultLockedError();
  await current.setProfile(profile);
  await mirrorUnlocked(profile);
  emit('unlocked');
}

/**
 * Reveal the sensitive `secrets` section. Requires an explicit `confirm: true`
 * argument — anything else is a compile error and is rejected at runtime too.
 */
export async function getSecrets(confirm: true): Promise<Secrets> {
  if (confirm !== true) {
    throw new Error('getSecrets() requires an explicit confirmation.');
  }
  const current = getLock();
  if (!current.isUnlocked) throw new VaultLockedError();
  return current.getSecrets({ includeSecrets: true });
}

/** Subscribe to status changes. Returns an unsubscribe function. */
export function onVaultChange(callback: VaultChangeListener): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}
