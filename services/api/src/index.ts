/**
 * Public surface of `@diggy/api` — the local connect-backend for the browser
 * extension. Import `buildServer`/`startServer` to run it, or the individual
 * modules for embedding and testing.
 */
export {
  createContext,
  getContext,
  resetContext,
  DEFAULT_DB_PATH,
  DEFAULT_PORT,
  DEFAULT_PUBLIC_URL,
  KV_SESSION_SECRET,
  KV_TOKEN_KEY,
} from './config.js';
export type { AppConfig, AppContext, CreateContextOptions, OAuthCredentials } from './config.js';

export {
  claimPairing,
  createPairing,
  deleteConnection,
  deleteSession,
  getConnection,
  getKv,
  getPairing,
  getSession,
  getUserByGoogleSub,
  getUserById,
  insertSession,
  listConnections,
  openDatabase,
  readyPairing,
  setKv,
  upsertConnection,
  upsertUser,
} from './db.js';
export type {
  ConnectionRow,
  PairingRow,
  SessionRow,
  SqliteDb,
  UpsertConnectionInput,
  UpsertUserInput,
  UserRow,
} from './db.js';

export { decryptString, encryptString, signSession, verifySession, SESSION_TTL_MS } from './crypto.js';
export type { VerifiedSession } from './crypto.js';

export { getProvider, isProviderId, listProviders, PROVIDERS } from './providers.js';
export type { ProviderAuthKind, ProviderDefinition, ProviderId } from './providers.js';

export {
  beginAuth,
  exchangeCode,
  fetchAccountLabel,
  fetchGoogleProfile,
  isOAuthProvider,
  refresh,
  OAuthError,
} from './oauth.js';
export type { TokenSet } from './oauth.js';

export { buildServer, startServer, HOST } from './server.js';
export type { BuildServerOptions } from './server.js';

export { registerActionRoutes, HttpError } from './routes/actions.js';
export { registerAuthRoutes, requireUser, successHtml, userFromRequest } from './routes/auth.js';
export { registerPluginRoutes } from './routes/plugins.js';
export {
  faviconUrlFor,
  latestForChannel,
  normalizeChannelInput,
  parseMeta,
  parseYouTubeFeed,
  registerPreviewRoutes,
  resolveChannelId,
} from './routes/preview.js';
export type { MetaResult, YouTubeVideo } from './routes/preview.js';
