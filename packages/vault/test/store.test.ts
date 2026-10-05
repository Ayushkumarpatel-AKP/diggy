// fake-indexeddb installs a global indexedDB so Dexie works under Node.
import 'fake-indexeddb/auto';
import { afterAll, describe, expect, it } from 'vitest';
import { IndexedDbAdapter, MemoryAdapter } from '../src/store';
import { encryptJson, type EncryptedBlob } from '../src/crypto';
import { CHEAP_PARAMS, TEST_PASSPHRASE } from './fixtures';

async function makeBlob(payload: unknown): Promise<EncryptedBlob> {
  return encryptJson(payload, TEST_PASSPHRASE, CHEAP_PARAMS);
}

describe('MemoryAdapter', () => {
  it('saves, loads and deletes blobs', async () => {
    const store = new MemoryAdapter();
    const blob = await makeBlob({ hello: 'world' });

    expect(await store.load('profile')).toBeUndefined();
    await store.save('profile', blob);
    expect(await store.load('profile')).toEqual(blob);
    expect(store.size).toBe(1);

    await store.delete('profile');
    expect(await store.load('profile')).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('returns defensive copies', async () => {
    const store = new MemoryAdapter();
    const blob = await makeBlob({ a: 1 });
    await store.save('profile', blob);

    const loaded = await store.load('profile');
    (loaded as EncryptedBlob).ciphertext = 'tampered';
    expect((await store.load('profile'))?.ciphertext).not.toBe('tampered');
  });
});

describe('IndexedDbAdapter (Dexie + fake-indexeddb)', () => {
  const store = new IndexedDbAdapter('diggy-vault-test');
  afterAll(async () => {
    await store.close();
  });

  it('saves, loads and deletes blobs', async () => {
    const blob = await makeBlob({ name: 'Ada' });

    expect(await store.load('profile')).toBeUndefined();
    await store.save('profile', blob);
    expect(await store.load('profile')).toEqual(blob);

    const other = await makeBlob({ name: 'Grace' });
    await store.save('work', other);
    expect(await store.load('work')).toEqual(other);

    await store.delete('profile');
    expect(await store.load('profile')).toBeUndefined();
    expect(await store.load('work')).toEqual(other);
  });

  it('overwrites an existing id', async () => {
    const first = await makeBlob({ rev: 1 });
    const second = await makeBlob({ rev: 2 });
    await store.save('overwrite', first);
    await store.save('overwrite', second);
    expect(await store.load('overwrite')).toEqual(second);
  });
});
