/**
 * @diggy/vault — storage adapters.
 *
 * Only ever stores `EncryptedBlob`s (ciphertext). The plaintext profile and the
 * derived key never reach a `StorageAdapter`.
 */
import Dexie, { type Table } from 'dexie';
import type { EncryptedBlob } from './crypto';

/** A tiny persistence abstraction so the lock logic is storage-agnostic. */
export interface StorageAdapter {
  save(id: string, blob: EncryptedBlob): Promise<void>;
  load(id: string): Promise<EncryptedBlob | undefined>;
  delete(id: string): Promise<void>;
}

interface BlobRow {
  id: string;
  blob: EncryptedBlob;
}

/**
 * IndexedDB-backed adapter (browser + Node tests via fake-indexeddb).
 * Stores one row per vault id in a `blobs` table.
 */
export class IndexedDbAdapter implements StorageAdapter {
  private readonly db: Dexie & { blobs: Table<BlobRow, string> };

  constructor(dbName = 'diggy-vault') {
    const db = new Dexie(dbName) as Dexie & { blobs: Table<BlobRow, string> };
    db.version(1).stores({ blobs: 'id' });
    this.db = db;
  }

  async save(id: string, blob: EncryptedBlob): Promise<void> {
    await this.db.blobs.put({ id, blob });
  }

  async load(id: string): Promise<EncryptedBlob | undefined> {
    const row = await this.db.blobs.get(id);
    return row?.blob;
  }

  async delete(id: string): Promise<void> {
    await this.db.blobs.delete(id);
  }

  /** Closes the underlying connection (useful for tests / hot reload). */
  async close(): Promise<void> {
    this.db.close();
  }
}

/** In-memory adapter for tests and ephemeral use. */
export class MemoryAdapter implements StorageAdapter {
  private readonly map = new Map<string, EncryptedBlob>();

  async save(id: string, blob: EncryptedBlob): Promise<void> {
    this.map.set(id, structuredClone(blob));
  }

  async load(id: string): Promise<EncryptedBlob | undefined> {
    const blob = this.map.get(id);
    return blob === undefined ? undefined : structuredClone(blob);
  }

  async delete(id: string): Promise<void> {
    this.map.delete(id);
  }

  /** Number of stored blobs (test/inspection helper). */
  get size(): number {
    return this.map.size;
  }
}
