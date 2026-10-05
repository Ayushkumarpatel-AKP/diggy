import { describe, expect, it } from 'vitest';
import { MemoryAdapter } from '../src/store';
import { VaultLock, VaultLockedError, VaultNotFoundError, initializeVault } from '../src/lock';
import { stripSecrets } from '../src/profile.schema';
import { CHEAP_PARAMS, PII_STRINGS, TEST_PASSPHRASE, sampleProfile } from './fixtures';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function provisioned(): Promise<MemoryAdapter> {
  const store = new MemoryAdapter();
  await initializeVault(store, TEST_PASSPHRASE, sampleProfile(), { params: CHEAP_PARAMS });
  return store;
}

describe('VaultLock — unlock / lock', () => {
  it('throws when there is no vault to unlock', async () => {
    const lock = new VaultLock(new MemoryAdapter(), { autoLockMinutes: 0 });
    await expect(lock.unlock(TEST_PASSPHRASE)).rejects.toBeInstanceOf(VaultNotFoundError);
    expect(lock.isUnlocked).toBe(false);
  });

  it('rejects a wrong passphrase and stays locked', async () => {
    const lock = new VaultLock(await provisioned(), { autoLockMinutes: 0 });
    await expect(lock.unlock('nope')).rejects.toThrow();
    expect(lock.isUnlocked).toBe(false);
    expect(() => lock.getProfile()).toThrow(VaultLockedError);
  });

  it('gives back a stripped profile (no secrets) by default; secrets need an explicit flag', async () => {
    const lock = new VaultLock(await provisioned(), { autoLockMinutes: 0 });
    await lock.unlock(TEST_PASSPHRASE);

    const withoutSecrets = lock.getProfile();
    expect('secrets' in withoutSecrets).toBe(false);
    expect(withoutSecrets).toEqual(stripSecrets(sampleProfile()));

    expect(lock.getSecrets({ includeSecrets: true })).toEqual(sampleProfile().secrets);

    // Any non-explicit call must be refused.
    const loose = lock.getSecrets.bind(lock) as (o: unknown) => unknown;
    expect(() => loose({ includeSecrets: false })).toThrow();
    expect(() => loose({})).toThrow();
  });

  it('re-encrypts + persists on setProfile, surviving a lock/unlock cycle', async () => {
    const store = await provisioned();
    const lock = new VaultLock(store, { autoLockMinutes: 0 });
    await lock.unlock(TEST_PASSPHRASE);

    const updated = sampleProfile();
    updated.identity.city = 'Manchester';
    updated.skills = ['mathematics', 'analytical engines', 'punched cards'];
    await lock.setProfile(updated);

    lock.lock();
    expect(lock.isUnlocked).toBe(false);
    expect(() => lock.getProfile()).toThrow(VaultLockedError);

    const reopened = new VaultLock(store, { autoLockMinutes: 0 });
    await reopened.unlock(TEST_PASSPHRASE);
    expect(reopened.getProfile()).toEqual(stripSecrets(updated));
  });

  it('refuses setProfile while locked', async () => {
    const lock = new VaultLock(await provisioned(), { autoLockMinutes: 0 });
    await expect(lock.setProfile(sampleProfile())).rejects.toBeInstanceOf(VaultLockedError);
  });

  it('never persists the plaintext, the passphrase, or a key (ciphertext at rest)', async () => {
    const store = await provisioned();
    const lock = new VaultLock(store, { autoLockMinutes: 0 });
    await lock.unlock(TEST_PASSPHRASE);
    await lock.setProfile(sampleProfile());

    const stored = await store.load('profile');
    expect(stored).toBeDefined();
    expect(stored?.version).toBe(1);
    expect(stored?.kdf).toBe('argon2id');
    expect(Object.keys(stored ?? {}).sort()).toEqual([
      'ciphertext',
      'iv',
      'kdf',
      'params',
      'salt',
      'version',
    ]);

    const serialized = JSON.stringify(stored);
    for (const secret of PII_STRINGS) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain(TEST_PASSPHRASE);
    // The adapter only ever saw ciphertext.
    expect(store.size).toBe(1);
  });

  it('does not leave a half-initialised session after a bad unlock', async () => {
    const lock = new VaultLock(await provisioned(), { autoLockMinutes: 0 });
    await expect(lock.unlock('wrong')).rejects.toThrow();
    // A subsequent good unlock still works.
    await lock.unlock(TEST_PASSPHRASE);
    expect(lock.isUnlocked).toBe(true);
  });
});

describe('VaultLock — auto-lock', () => {
  it('auto-locks after inactivity and fires onLock', async () => {
    let lockedCount = 0;
    const lock = new VaultLock(await provisioned(), {
      autoLockMinutes: 0.005, // ~300ms
      onLock: () => {
        lockedCount += 1;
      },
    });

    await lock.unlock(TEST_PASSPHRASE);
    expect(lock.isUnlocked).toBe(true);

    await delay(450);
    expect(lock.isUnlocked).toBe(false);
    expect(lockedCount).toBe(1);
    expect(() => lock.getProfile()).toThrow(VaultLockedError);
  });

  it('touch() defers auto-lock; inactivity afterwards locks', async () => {
    const lock = new VaultLock(await provisioned(), { autoLockMinutes: 0.005 }); // ~300ms
    await lock.unlock(TEST_PASSPHRASE);

    for (let i = 0; i < 5; i += 1) {
      await delay(80);
      lock.touch();
    }
    // ~400ms elapsed but never idle for 300ms straight.
    expect(lock.isUnlocked).toBe(true);

    await delay(500);
    expect(lock.isUnlocked).toBe(false);
  });

  it('autoLockMinutes <= 0 disables auto-lock', async () => {
    const lock = new VaultLock(await provisioned(), { autoLockMinutes: 0 });
    await lock.unlock(TEST_PASSPHRASE);
    await delay(120);
    expect(lock.isUnlocked).toBe(true);

    lock.lock();
    expect(lock.isUnlocked).toBe(false);
  });

  it('does not fire onLock when locking an already-locked vault', async () => {
    let lockedCount = 0;
    const lock = new VaultLock(await provisioned(), {
      autoLockMinutes: 0,
      onLock: () => {
        lockedCount += 1;
      },
    });
    lock.lock();
    expect(lockedCount).toBe(0);

    await lock.unlock(TEST_PASSPHRASE);
    lock.lock();
    lock.lock();
    expect(lockedCount).toBe(1);
  });
});
