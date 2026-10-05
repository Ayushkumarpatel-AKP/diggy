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
