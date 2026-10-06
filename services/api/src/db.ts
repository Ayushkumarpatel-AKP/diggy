/**
 * SQLite persistence for the Diggy connect-backend.
 *
 * Everything lives in one file (`./.data/diggy.db` by default). The schema
 * below covers the four things the server needs to remember:
 *
 *   - `users`       — one row per signed-in Google identity.
 *   - `sessions`    — issued (stateless) session tokens, for revocation/expiry.
 *   - `connections` — per-user plugin connections. Access/refresh tokens are
 *                     stored **encrypted** (see {@link ./crypto.ts}); the
 *                     *ct columns hold the AES-GCM ciphertext, never plaintext.
 *   - `pairings`    — short-lived handshake codes that let the browser
 *                     extension pick up a freshly-minted session token.
 *   - `kv`          — small key/value store (auto-generated secrets live here).
 *
 * This module is deliberately free of any config/network imports so the config
 * layer can open the database without an import cycle.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

/** A better-sqlite3 database handle. */
export type SqliteDb = Database.Database;

export interface UserRow {
  id: string;
  google_sub: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  created_at: string;
}

export interface SessionRow {
  token: string;
  user_id: string;
  created_at: string;
  expires_at: string;
}

export interface ConnectionRow {
  id: string;
  user_id: string;
  provider: string;
  account_label: string | null;
  access_token_ct: string;
  refresh_token_ct: string | null;
  expires_at: string | null;
  scopes: string | null;
  created_at: string;
}

export interface PairingRow {
  code: string;
  session_token: string | null;
  user_json: string | null;
  created_at: string;
  claimed: number;
}

/** The full schema, applied idempotently on every open. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  google_sub TEXT UNIQUE,
  email      TEXT,
  name       TEXT,
  picture    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connections (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  provider         TEXT NOT NULL,
  account_label    TEXT,
  access_token_ct  TEXT NOT NULL,
  refresh_token_ct TEXT,
  expires_at       TEXT,
  scopes           TEXT,
  created_at       TEXT NOT NULL,
  UNIQUE(user_id, provider)
);

CREATE TABLE IF NOT EXISTS pairings (
  code          TEXT PRIMARY KEY,
  session_token TEXT,
  user_json     TEXT,
  created_at    TEXT NOT NULL,
  claimed       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Open (creating if needed) the SQLite database at `dbPath` and apply the
 * schema. Accepts `:memory:` for tests. The parent directory is created on
 * demand so a fresh checkout works with no setup.
 */
export function openDatabase(dbPath: string): SqliteDb {
  if (dbPath !== ':memory:') {
    const dir = dirname(dbPath);
    if (dir && dir !== '.' && dir !== '') mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/* ------------------------------------------------------------------ kv ---- */

export function getKv(db: SqliteDb, key: string): string | undefined {
  const row = db
    .prepare<[string], { value: string }>('SELECT value FROM kv WHERE key = ?')
    .get(key);
  return row?.value;
}

export function setKv(db: SqliteDb, key: string, value: string): void {
  db.prepare<[string, string]>(
    'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/* --------------------------------------------------------------- users ---- */

export interface UpsertUserInput {
  id: string;
  googleSub: string;
  email?: string | null;
  name?: string | null;
  picture?: string | null;
}

/** Insert a user, or refresh the profile fields when the Google sub exists. */
export function upsertUser(db: SqliteDb, input: UpsertUserInput): UserRow {
  const now = new Date().toISOString();
  db.prepare<[string, string, string | null, string | null, string | null, string]>(`
    INSERT INTO users (id, google_sub, email, name, picture, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(google_sub) DO UPDATE SET
      email   = excluded.email,
      name    = excluded.name,
      picture = excluded.picture
  `).run(input.id, input.googleSub, input.email ?? null, input.name ?? null, input.picture ?? null, now);
  const row = getUserByGoogleSub(db, input.googleSub);
  if (!row) throw new Error('Failed to upsert user');
  return row;
}

export function getUserById(db: SqliteDb, id: string): UserRow | undefined {
  return db.prepare<[string], UserRow>('SELECT * FROM users WHERE id = ?').get(id);
}

export function getUserByGoogleSub(db: SqliteDb, googleSub: string): UserRow | undefined {
  return db.prepare<[string], UserRow>('SELECT * FROM users WHERE google_sub = ?').get(googleSub);
}

/* ------------------------------------------------------------ sessions ---- */

export function insertSession(db: SqliteDb, row: SessionRow): void {
  db.prepare<[string, string, string, string]>(
    'INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ).run(row.token, row.user_id, row.created_at, row.expires_at);
}

export function getSession(db: SqliteDb, token: string): SessionRow | undefined {
  return db.prepare<[string], SessionRow>('SELECT * FROM sessions WHERE token = ?').get(token);
}

export function deleteSession(db: SqliteDb, token: string): void {
  db.prepare<[string]>('DELETE FROM sessions WHERE token = ?').run(token);
}

/* --------------------------------------------------------- connections ---- */

export interface UpsertConnectionInput {
  id: string;
  userId: string;
  provider: string;
  accountLabel?: string | null;
  accessTokenCt: string;
  refreshTokenCt?: string | null;
  expiresAt?: string | null;
  scopes?: string | null;
}

export function upsertConnection(db: SqliteDb, input: UpsertConnectionInput): ConnectionRow {
  const now = new Date().toISOString();
  db.prepare<
    [string, string, string, string | null, string, string | null, string | null, string | null, string]
  >(`
    INSERT INTO connections
      (id, user_id, provider, account_label, access_token_ct, refresh_token_ct, expires_at, scopes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      account_label    = excluded.account_label,
      access_token_ct  = excluded.access_token_ct,
      refresh_token_ct = COALESCE(excluded.refresh_token_ct, connections.refresh_token_ct),
      expires_at       = excluded.expires_at,
      scopes           = excluded.scopes
  `).run(
    input.id,
    input.userId,
    input.provider,
    input.accountLabel ?? null,
    input.accessTokenCt,
    input.refreshTokenCt ?? null,
    input.expiresAt ?? null,
    input.scopes ?? null,
    now,
  );
  const row = getConnection(db, input.userId, input.provider);
  if (!row) throw new Error('Failed to upsert connection');
  return row;
}

export function getConnection(
  db: SqliteDb,
  userId: string,
  provider: string,
): ConnectionRow | undefined {
  return db
    .prepare<[string, string], ConnectionRow>(
      'SELECT * FROM connections WHERE user_id = ? AND provider = ?',
    )
    .get(userId, provider);
}

export function listConnections(db: SqliteDb, userId: string): ConnectionRow[] {
  return db
    .prepare<[string], ConnectionRow>('SELECT * FROM connections WHERE user_id = ?')
    .all(userId);
}

export function deleteConnection(db: SqliteDb, userId: string, provider: string): boolean {
  const info = db
    .prepare<[string, string]>('DELETE FROM connections WHERE user_id = ? AND provider = ?')
    .run(userId, provider);
  return info.changes > 0;
}

/* ------------------------------------------------------------ pairings ---- */

export function createPairing(db: SqliteDb, code: string): PairingRow {
  const now = new Date().toISOString();
  db.prepare<[string, string]>(
    `INSERT INTO pairings (code, session_token, user_json, created_at, claimed)
     VALUES (?, NULL, NULL, ?, 0)
     ON CONFLICT(code) DO UPDATE SET
       session_token = NULL,
       user_json     = NULL,
       created_at    = excluded.created_at,
       claimed       = 0`,
  ).run(code, now);
  const row = getPairing(db, code);
  if (!row) throw new Error('Failed to create pairing');
  return row;
}

export function getPairing(db: SqliteDb, code: string): PairingRow | undefined {
  return db.prepare<[string], PairingRow>('SELECT * FROM pairings WHERE code = ?').get(code);
}

/** Mark a pairing as fulfilled with a session token + serialized user. */
export function readyPairing(
  db: SqliteDb,
  code: string,
  sessionToken: string,
  userJson: string,
): void {
  db.prepare<[string, string, string]>(
    'UPDATE pairings SET session_token = ?, user_json = ? WHERE code = ?',
  ).run(sessionToken, userJson, code);
}

/** Atomically claim a ready, unclaimed pairing. Returns the row it consumed. */
export function claimPairing(db: SqliteDb, code: string): PairingRow | undefined {
  const claim = db.transaction((c: string): PairingRow | undefined => {
    const row = getPairing(db, c);
    if (!row || row.claimed === 1 || !row.session_token) return undefined;
    db.prepare<[string]>('UPDATE pairings SET claimed = 1 WHERE code = ?').run(c);
    return { ...row, claimed: 1 };
  });
  return claim(code);
}
