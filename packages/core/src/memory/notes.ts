/**
 * Simple key/value "notes" store.
 *
 * Persistence is the host's job: the desktop app backs this with the encrypted
 * vault (SQLite), the extension with Dexie. `@diggy/core` just defines the
 * interface plus an in-memory implementation for tests and ephemeral use.
 */

export interface NoteEntry {
  key: string;
  value: string;
  updatedAt: string;
}

export interface NotesStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<NoteEntry>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  keys(): Promise<string[]>;
  entries(): Promise<NoteEntry[]>;
  clear(): Promise<void>;
}

/** In-memory {@link NotesStore} — useful for tests and short-lived sessions. */
export class InMemoryNotesStore implements NotesStore {
  private readonly map = new Map<string, NoteEntry>();

  constructor(initial?: Iterable<NoteEntry>) {
    if (initial) {
      for (const entry of initial) {
        this.map.set(entry.key, { ...entry });
      }
    }
  }

  async get(key: string): Promise<string | undefined> {
    return this.map.get(key)?.value;
  }

  async set(key: string, value: string): Promise<NoteEntry> {
    const entry: NoteEntry = { key, value, updatedAt: new Date().toISOString() };
    this.map.set(key, entry);
    return entry;
  }

  async has(key: string): Promise<boolean> {
    return this.map.has(key);
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }

  async keys(): Promise<string[]> {
    return [...this.map.keys()];
  }

  async entries(): Promise<NoteEntry[]> {
    return [...this.map.values()].map((entry) => ({ ...entry }));
  }

  async clear(): Promise<void> {
    this.map.clear();
  }

  /** Serializable snapshot, e.g. to persist into the vault. */
  toJSON(): NoteEntry[] {
    return [...this.map.values()].map((entry) => ({ ...entry }));
  }
}
