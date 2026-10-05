/**
 * @diggy/vault — public barrel.
 *
 * Encrypted profile vault: Argon2id KDF + AES-256-GCM, storage adapters, and an
 * auto-locking in-memory session.
 */
export * from './crypto';
export * from './profile.schema';
export * from './store';
export * from './lock';
