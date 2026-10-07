/**
 * Persistent chat memory shared by the side panel (typed chat) and the
 * background brain (voice / push-to-talk), so the conversation continues across
 * service-worker restarts and across both entry points.
 */
import type { ChatMessage } from '@diggy/shared';

export const MAX_CHAT_MESSAGES = 60;
const CHAT_KEY = 'diggy:chat';

export async function loadChat(): Promise<ChatMessage[]> {
  try {
    const store = (await browser.storage.local.get(CHAT_KEY)) as Record<string, unknown>;
    const value = store[CHAT_KEY];
    return Array.isArray(value) ? (value as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

export async function saveChat(messages: ChatMessage[]): Promise<void> {
  try {
    await browser.storage.local.set({ [CHAT_KEY]: messages.slice(-MAX_CHAT_MESSAGES) });
  } catch {
    /* best-effort */
  }
}

export async function appendChat(...messages: ChatMessage[]): Promise<ChatMessage[]> {
  const current = await loadChat();
  const next = [...current, ...messages].slice(-MAX_CHAT_MESSAGES);
  await saveChat(next);
  return next;
}

export async function clearChat(): Promise<void> {
  try {
    await browser.storage.local.remove(CHAT_KEY);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ *
 * Durable agent checkpoint
 * ------------------------------------------------------------------ */

/**
 * The runtime's checkpoint, persisted next to the chat history so a run the
 * MV3 worker was killed in the middle of can be resumed in the same
 * conversation (see `agent-host.ts` and `@diggy/agent`'s `AgentRuntime`).
 *
 * The checkpoint itself is kept opaque here (stored as JSON, never interpreted)
 * — the agent host validates it with `normalizeCheckpoint` before use. That
 * keeps this module free of any dependency on the agent runtime.
 */
export const AGENT_CHECKPOINT_KEY = 'diggy:agent:checkpoint';

export interface StoredAgentCheckpoint {
  /** The runtime `Checkpoint`, stored verbatim. */
  checkpoint: unknown;
  /** True once the run reached a terminal state that must not be resumed. */
  finished: boolean;
  updatedAt: string;
}

export async function loadAgentCheckpoint(): Promise<StoredAgentCheckpoint | null> {
  try {
    const store = (await browser.storage.local.get(AGENT_CHECKPOINT_KEY)) as Record<string, unknown>;
    const value = store[AGENT_CHECKPOINT_KEY];
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<StoredAgentCheckpoint>;
    if (!('checkpoint' in candidate)) return null;
    return {
      checkpoint: candidate.checkpoint,
      finished: candidate.finished === true,
      updatedAt:
        typeof candidate.updatedAt === 'string' ? candidate.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function saveAgentCheckpoint(checkpoint: unknown, finished = false): Promise<void> {
  try {
    const record: StoredAgentCheckpoint = {
      checkpoint,
      finished,
      updatedAt: new Date().toISOString(),
    };
    await browser.storage.local.set({ [AGENT_CHECKPOINT_KEY]: record });
  } catch {
    /* best-effort — losing a checkpoint must never crash the worker */
  }
}

export async function clearAgentCheckpoint(): Promise<void> {
  try {
    await browser.storage.local.remove(AGENT_CHECKPOINT_KEY);
  } catch {
    /* ignore */
  }
}
