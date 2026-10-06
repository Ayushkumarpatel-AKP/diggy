/**
 * Runtime configuration for the Diggy connect-backend.
 *
 * Every setting is optional and has a sane localhost default. Two secrets are
 * special: {@link AppConfig.tokenKey} (the AES-256 key that encrypts OAuth
 * tokens at rest) and {@link AppConfig.sessionSecret} (the HMAC key that signs
 * session tokens). If they are not supplied via env we **generate** them once
 * and persist them in the database's `kv` table, so tokens written today stay
 * decryptable across restarts.
 */
import { randomBytes } from 'node:crypto';

import { getKv, openDatabase, setKv, type SqliteDb } from './db.js';

export interface OAuthCredentials {
  clientId?: string;
  clientSecret?: string;
}

export interface AppConfig {
  port: number;
  dbPath: string;
  /** Public base URL used to build OAuth redirect_uri values. */
  publicUrl: string;
  /** 32-byte AES-256-GCM key for encrypting tokens at rest. */
  tokenKey: Buffer;
  /** HMAC key for signing stateless session tokens. */
  sessionSecret: string;
  /** True when the AES key was generated (and persisted) rather than configured. */
  tokenKeyGenerated: boolean;
  /** True when the session secret was generated rather than configured. */
  sessionSecretGenerated: boolean;
  providers: {
    google: OAuthCredentials;
    notion: OAuthCredentials;
    github: OAuthCredentials;
  };
}

export interface AppContext {
  config: AppConfig;
  db: SqliteDb;
}

export const DEFAULT_PORT = 17323;
export const DEFAULT_DB_PATH = './.data/diggy.db';
export const DEFAULT_PUBLIC_URL = `http://127.0.0.1:${DEFAULT_PORT}`;

export const KV_TOKEN_KEY = 'token_key';
export const KV_SESSION_SECRET = 'session_secret';

type Env = Record<string, string | undefined>;

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : fallback;
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** 64 hex chars = 32 bytes = a valid AES-256 key. */
function parseHexKey(raw: string | undefined): Buffer | undefined {
  if (!raw || !/^[0-9a-fA-F]{64}$/.test(raw)) return undefined;
  return Buffer.from(raw, 'hex');
}

function resolveTokenKey(env: Env, db: SqliteDb): { key: Buffer; generated: boolean } {
  const configured = parseHexKey(env.DIGGY_TOKEN_KEY);
  if (configured) return { key: configured, generated: false };

  const stored = parseHexKey(getKv(db, KV_TOKEN_KEY));
  if (stored) return { key: stored, generated: false };

  const generated = randomBytes(32).toString('hex');
  setKv(db, KV_TOKEN_KEY, generated);
  return { key: Buffer.from(generated, 'hex'), generated: true };
}

function resolveSessionSecret(env: Env, db: SqliteDb): { secret: string; generated: boolean } {
  const configured = trimOrUndefined(env.SESSION_SECRET);
  if (configured) return { secret: configured, generated: false };

  const stored = trimOrUndefined(getKv(db, KV_SESSION_SECRET));
  if (stored) return { secret: stored, generated: false };

  const generated = randomBytes(32).toString('hex');
  setKv(db, KV_SESSION_SECRET, generated);
  return { secret: generated, generated: true };
}

export interface CreateContextOptions {
  dbPath?: string;
  env?: Env;
}

/**
 * Build a fresh {@link AppContext}: resolve config, open the database and make
 * sure both secrets exist. Tests pass an explicit `dbPath` (e.g. `:memory:`).
 */
export function createContext(options: CreateContextOptions = {}): AppContext {
  const env = options.env ?? process.env;
  const dbPath = options.dbPath ?? trimOrUndefined(env.DB_PATH) ?? DEFAULT_DB_PATH;
  const db = openDatabase(dbPath);

  const token = resolveTokenKey(env, db);
  const session = resolveSessionSecret(env, db);

  const config: AppConfig = {
    port: parsePort(env.PORT, DEFAULT_PORT),
    dbPath,
    publicUrl: (trimOrUndefined(env.PUBLIC_URL) ?? DEFAULT_PUBLIC_URL).replace(/\/+$/, ''),
    tokenKey: token.key,
    sessionSecret: session.secret,
    tokenKeyGenerated: token.generated,
    sessionSecretGenerated: session.generated,
    providers: {
      google: {
        clientId: trimOrUndefined(env.GOOGLE_CLIENT_ID),
        clientSecret: trimOrUndefined(env.GOOGLE_CLIENT_SECRET),
      },
      notion: {
        clientId: trimOrUndefined(env.NOTION_CLIENT_ID),
        clientSecret: trimOrUndefined(env.NOTION_CLIENT_SECRET),
      },
      github: {
        clientId: trimOrUndefined(env.GITHUB_CLIENT_ID),
        clientSecret: trimOrUndefined(env.GITHUB_CLIENT_SECRET),
      },
    },
  };

  return { config, db };
}

let context: AppContext | undefined;

/** Process-wide singleton context, created lazily on first use. */
export function getContext(): AppContext {
  context ??= createContext();
  return context;
}

/** Test helper: forget the cached singleton so the next call rebuilds it. */
export function resetContext(): void {
  context = undefined;
}
