/**
 * @diggy/agent — a durable agent runtime for the MV3 service worker.
 *
 * The extension's brain currently runs a single turn (`brain.ts`) through
 * `runAgent` (`packages/core/src/orchestrator.ts`). That is enough for a chat
 * reply but it cannot survive the worker being torn down mid-task, and it has no
 * step budget, no loop guard, no token budgeting and no role-based model
 * selection. This package adds exactly those, with every dependency injected.
 *
 * It depends on nothing — not `ai`, not `chrome`, not the network — so it runs
 * unchanged in the worker and in Vitest.
 */
export * from './types';
export * from './activity';
export * from './budget';
export * from './loop';
export * from './storage';
export * from './runtime';
export * from './tokens';
export * from './router';
