import type {
  AvatarMood,
  AvatarState,
  FillInstruction,
  PageContext,
  Profile,
  Reminder,
} from './types.js';

export interface HelloMessage {
  kind: 'hello';
  protocol: number;
  token: string;
  role: 'extension' | 'desktop';
}

export interface WelcomeMessage {
  kind: 'welcome';
  protocol: number;
  ok: boolean;
}

export interface ProtocolErrorMessage {
  kind: 'error';
  code: string;
  message: string;
}

export interface MethodParams {
  /**
   * Read a page. With no `url` it reads the active tab; with a `url` the host
   * fetches that page itself (so the assistant never has to ask the user to
   * open a tab).
   */
  readPage: { includeFields?: boolean; url?: string };
  fillForm: { fields: FillInstruction[]; submit?: boolean };
  getProfile: { section?: keyof Profile };
  createReminder: { title: string; dueAt: string; notes?: string };
  listReminders: Record<string, never>;
  crawl: { url: string; depth?: number; maxPages?: number };
  searchWeb: { query: string };
  /** Read recent Gmail messages (requires the Google connection). */
  readInbox: { query?: string; max?: number };
  /** Read upcoming calendar events (requires the Google connection). */
  readCalendar: { days?: number; max?: number };
  notify: { title: string; body?: string };
  speak: { text: string };
  setMood: { mood: AvatarMood };
  playAnim: { state: AvatarState };
}

export interface MethodResults {
  readPage: PageContext;
  fillForm: { filled: number; skipped: string[] };
  getProfile: Partial<Profile>;
  createReminder: Reminder;
  listReminders: Reminder[];
  crawl: { url: string; title: string; markdown: string }[];
  searchWeb: { title: string; url: string; snippet: string }[];
  readInbox: { id: string; from: string; subject: string; snippet: string; date: string }[];
  readCalendar: { id: string; summary: string; start: string; location?: string }[];
  notify: void;
  speak: void;
  setMood: void;
  playAnim: void;
}

export type BridgeMethod = keyof MethodParams;

export interface BridgeRequest<M extends BridgeMethod = BridgeMethod> {
  kind: 'request';
  id: string;
  method: M;
  params: MethodParams[M];
}

export type BridgeResponse<M extends BridgeMethod = BridgeMethod> =
  | { kind: 'response'; id: string; method: M; ok: true; result: MethodResults[M] }
  | { kind: 'response'; id: string; method: M; ok: false; error: string };

export type BridgeEventName = 'avatar' | 'chat' | 'notification' | 'opportunity';

export interface BridgeEvent {
  kind: 'event';
  event: BridgeEventName;
  payload: unknown;
}

export type BridgeMessage =
  | HelloMessage
  | WelcomeMessage
  | ProtocolErrorMessage
  | BridgeRequest
  | BridgeResponse
  | BridgeEvent;

export function isBridgeRequest(message: BridgeMessage): message is BridgeRequest {
  return message.kind === 'request';
}

export function isBridgeResponse(message: BridgeMessage): message is BridgeResponse {
  return message.kind === 'response';
}

export function isBridgeEvent(message: BridgeMessage): message is BridgeEvent {
  return message.kind === 'event';
}
