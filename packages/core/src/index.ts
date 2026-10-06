/**
 * @diggy/core — the brain.
 *
 * Provider-agnostic LLM orchestration, the Diggy persona, the tool registry,
 * and lightweight memory. Nothing here imports `three`, the DOM, or the vault,
 * so it runs equally in the Tauri desktop brain, the extension service worker,
 * or plain Node (tests).
 */
export * from './providers';
export * from './errors';
export * from './tools';
export * from './prompt';
export * from './orchestrator';
export * from './memory/conversation';
export * from './memory/notes';
