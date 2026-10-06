/**
 * Internal messaging protocol between the extension's own contexts
 * (side panel ⇄ background ⇄ content script), plus small typed helpers.
 *
 * This is deliberately separate from the `@diggy/shared` bridge protocol: that
 * one talks to the *desktop companion* over WebSocket, this one relays between
 * our own runtime contexts over `chrome.runtime` / `chrome.tabs`.
 */
import type {
  AvatarMood,
  AvatarState,
  BridgeEventName,
  FieldDescriptor,
  FillInstruction,
  PageContext,
  Reminder,
  RichCard,
} from '@diggy/shared';

/* ------------------------------------------------------------------ *
 * Content-script methods
 * ------------------------------------------------------------------ */

export interface ContentMethodParams {
  /** Read the current page (text + optional field descriptors). */
  readPage: { includeFields?: boolean };
  /** Only scan the form fields on the page. */
  scanFields: Record<string, never>;
  /** Apply fill instructions. Never submits. */
  fillForm: { fields: FillInstruction[] };
  /** Drive the in-page avatar's facial mood. */
  setMood: { mood: AvatarMood };
  /** Drive the in-page avatar's body animation state. */
  playAnim: { state: AvatarState };
  /** Speak text using the page's SpeechSynthesis. */
  speak: { text: string };
  /** Show / hide the floating avatar bubble. */
  toggleAvatar: { visible?: boolean };
  /** Liveness check. */
  ping: Record<string, never>;
}

export interface ContentMethodResults {
  readPage: PageContext;
  scanFields: FieldDescriptor[];
  fillForm: { filled: number; skipped: string[] };
  setMood: boolean;
  playAnim: boolean;
  speak: boolean;
  toggleAvatar: boolean;
  ping: boolean;
}

export type ContentMethod = keyof ContentMethodParams;

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

/** Any extension context → background: run a method on a tab's content script. */
export interface ContentCallMessage<M extends ContentMethod = ContentMethod> {
  type: 'diggy:content-call';
  method: M;
  params: ContentMethodParams[M];
  /** Target tab. Defaults to the active tab in the current window. */
  tabId?: number;
}

/** Background → content script. */
export interface ContentExecMessage<M extends ContentMethod = ContentMethod> {
  type: 'diggy:content-exec';
  method: M;
  params: ContentMethodParams[M];
}

/** The content script's reply (relayed back through the background). */
export type ContentResponse<M extends ContentMethod = ContentMethod> =
  | { type: 'diggy:content-response'; ok: true; method: M; result: ContentMethodResults[M] }
  | { type: 'diggy:content-response'; ok: false; method: M; error: string };

/** Best-effort, unsolicited event from a content script. */
export interface ContentEventMessage {
  type: 'diggy:content-event';
  event: 'ready' | 'avatar-toggle' | 'dom-changed';
  payload?: unknown;
}

/** Ask the background for the desktop bridge connection status. */
export interface BridgeStatusRequest {
  type: 'diggy:bridge-status-request';
}

export interface BridgeStatusResponse {
  type: 'diggy:bridge-status-response';
  connected: boolean;
  url: string;
  protocol: number;
}

/** Ask the background to (re)start the desktop bridge connection. */
export interface BridgeConnectMessage {
  type: 'diggy:bridge-connect';
}

/** Ask the background to close the desktop bridge connection. */
export interface BridgeDisconnectMessage {
  type: 'diggy:bridge-disconnect';
}

/** Ask the background to check watched sites now (optionally just one). */
export interface WatchCheckMessage {
  type: 'diggy:watch-check';
  id?: string;
}

/** Ask the background to poll Gmail + Calendar now. */
export interface GoogleCheckMessage {
  type: 'diggy:google-check';
}

/** Background → content script: what the microphone actually heard (transcript). */
export interface AgentHeardMessage {
  type: 'diggy:agent-heard';
  text: string;
}

/** Push-to-talk: begin recording (background drives the offscreen recorder). */
export interface RecStartMessage {
  type: 'diggy:rec-start';
}

/** Push-to-talk: stop recording, transcribe with Groq Whisper, then run the agent. */
export interface RecStopMessage {
  type: 'diggy:rec-stop';
}

/** Push-to-talk: pre-warm the offscreen recorder so the first press is instant. */
export interface RecWarmMessage {
  type: 'diggy:rec-warm';
}

/** Content script → background: open this URL in a new tab (reliable). */
export interface OpenUrlMessage {
  type: 'diggy:open-url';
  url: string;
}

/** Background → everyone: a `BridgeEvent` arrived from the desktop companion. */
export interface BridgeEventMessage {
  type: 'diggy:bridge-event';
  event: BridgeEventName;
  payload: unknown;
}

/** Ask the background to (re)schedule an alarm for a reminder. */
export interface ScheduleReminderMessage {
  type: 'diggy:reminder-schedule';
  reminder: Reminder;
}

/** Ask the background to raise a native notification. */
export interface NotifyMessage {
  type: 'diggy:notify';
  title: string;
  body?: string;
}

/** Content script → background: run the agent on a spoken/typed instruction. */
export interface AgentAskMessage {
  type: 'diggy:ask';
  text: string;
  tabId?: number;
}

/** Background → content script: a streamed chunk of the assistant reply. */
export interface AgentDeltaMessage {
  type: 'diggy:agent-delta';
  text: string;
}

/** Background → content script: the run finished. */
export interface AgentDoneMessage {
  type: 'diggy:agent-done';
  text: string;
  ok: boolean;
  /** True when the model already spoke (so the host must not speak again). */
  spoke?: boolean;
  /** Optional rich card (video, link, snapshot) to show with the reply. */
  card?: RichCard;
}

/** Background → content script: a fill plan awaiting confirmation. */
export interface FillPlanMessage {
  type: 'diggy:fill-plan';
  fields: FillInstruction[];
}

/** Content script → background: the user confirmed the fill plan. */
export interface FillApplyMessage {
  type: 'diggy:fill-apply';
  fields?: FillInstruction[];
}

export type ExtMessage =
  | ContentCallMessage
  | ContentExecMessage
  | ContentResponse
  | ContentEventMessage
  | BridgeStatusRequest
  | BridgeStatusResponse
  | BridgeConnectMessage
  | BridgeDisconnectMessage
  | WatchCheckMessage
  | GoogleCheckMessage
  | RecStartMessage
  | RecStopMessage
  | RecWarmMessage
  | OpenUrlMessage
  | AgentHeardMessage
  | BridgeEventMessage
  | ScheduleReminderMessage
  | NotifyMessage
  | AgentAskMessage
  | AgentDeltaMessage
  | AgentDoneMessage
  | FillPlanMessage
  | FillApplyMessage;

/* ------------------------------------------------------------------ *
 * Type guards
 * ------------------------------------------------------------------ */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isContentCall(message: unknown): message is ContentCallMessage {
  return isObject(message) && message.type === 'diggy:content-call';
}

export function isContentExec(message: unknown): message is ContentExecMessage {
  return isObject(message) && message.type === 'diggy:content-exec';
}

export function isContentResponse(message: unknown): message is ContentResponse {
  return isObject(message) && message.type === 'diggy:content-response';
}

export function isAgentAsk(message: unknown): message is AgentAskMessage {
  return isObject(message) && message.type === 'diggy:ask';
}

export function isAgentDelta(message: unknown): message is AgentDeltaMessage {
  return isObject(message) && message.type === 'diggy:agent-delta';
}

export function isAgentDone(message: unknown): message is AgentDoneMessage {
  return isObject(message) && message.type === 'diggy:agent-done';
}

export function isFillPlan(message: unknown): message is FillPlanMessage {
  return isObject(message) && message.type === 'diggy:fill-plan';
}

export function isFillApply(message: unknown): message is FillApplyMessage {
  return isObject(message) && message.type === 'diggy:fill-apply';
}

export function isBridgeConnect(message: unknown): message is BridgeConnectMessage {
  return isObject(message) && message.type === 'diggy:bridge-connect';
}

export function isBridgeDisconnect(message: unknown): message is BridgeDisconnectMessage {
  return isObject(message) && message.type === 'diggy:bridge-disconnect';
}

export function isWatchCheck(message: unknown): message is WatchCheckMessage {
  return isObject(message) && message.type === 'diggy:watch-check';
}

export function isGoogleCheck(message: unknown): message is GoogleCheckMessage {
  return isObject(message) && message.type === 'diggy:google-check';
}

export function isRecStart(message: unknown): message is RecStartMessage {
  return isObject(message) && message.type === 'diggy:rec-start';
}

export function isRecStop(message: unknown): message is RecStopMessage {
  return isObject(message) && message.type === 'diggy:rec-stop';
}

export function isRecWarm(message: unknown): message is RecWarmMessage {
  return isObject(message) && message.type === 'diggy:rec-warm';
}

export function isOpenUrl(message: unknown): message is OpenUrlMessage {
  return isObject(message) && message.type === 'diggy:open-url' && typeof message.url === 'string';
}

export function isAgentHeard(message: unknown): message is AgentHeardMessage {
  return isObject(message) && message.type === 'diggy:agent-heard';
}

/**
 * Send a message and retry when nothing answers.
 *
 * An MV3 service worker can be asleep when the first message arrives; every so
 * often that first send resolves with `undefined` instead of the reply. Three
 * quick attempts make push-to-talk reliable without any user-visible retry.
 */
async function sendWithRetry<T>(message: unknown, attempts = 3): Promise<T | undefined> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = (await browser.runtime.sendMessage(message)) as T | undefined;
      if (result !== undefined) return result;
    } catch {
      /* the worker may still be starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

const NO_RESPONSE = "Diggy's recorder did not answer — try again.";

/** Ask the background to start/stop a voice recording. */
export async function recStart(): Promise<{ ok?: boolean; error?: string }> {
  return (
    (await sendWithRetry<{ ok?: boolean; error?: string }>({ type: 'diggy:rec-start' })) ?? {
      ok: false,
      error: NO_RESPONSE,
    }
  );
}

export async function recStop(): Promise<{ ok?: boolean; text?: string; error?: string }> {
  return (
    (await sendWithRetry<{ ok?: boolean; text?: string; error?: string }>({ type: 'diggy:rec-stop' })) ?? {
      ok: false,
      error: NO_RESPONSE,
    }
  );
}

export async function recWarm(): Promise<{ ok?: boolean; error?: string }> {
  return (
    (await sendWithRetry<{ ok?: boolean; error?: string }>({ type: 'diggy:rec-warm' })) ?? {
      ok: false,
      error: NO_RESPONSE,
    }
  );
}

/** Ask the background to run the agent for `text` (fire-and-forget). */
export async function askAgent(text: string): Promise<void> {
  const message: AgentAskMessage = { type: 'diggy:ask', text };
  await browser.runtime.sendMessage(message);
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

export function makeId(prefix = 'id'): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${uuid}`;
}

/** Ask the background to execute a content-script method (defaults to active tab). */
export async function callContent<M extends ContentMethod>(
  method: M,
  params: ContentMethodParams[M],
  tabId?: number,
): Promise<ContentMethodResults[M]> {
  const message: ContentCallMessage<M> = { type: 'diggy:content-call', method, params, tabId };
  const response = (await browser.runtime.sendMessage(message)) as ContentResponse<M> | undefined;
  if (!response || response.type !== 'diggy:content-response') {
    throw new Error('No response from the Diggy background worker');
  }
  if (!response.ok) throw new Error(response.error || `Content script failed: ${method}`);
  return response.result;
}

/** Ask the background for the desktop bridge status. */
export async function getBridgeStatus(): Promise<BridgeStatusResponse> {
  const message: BridgeStatusRequest = { type: 'diggy:bridge-status-request' };
  const response = (await browser.runtime.sendMessage(message)) as BridgeStatusResponse | undefined;
  return (
    response ?? { type: 'diggy:bridge-status-response', connected: false, url: '', protocol: 0 }
  );
}
