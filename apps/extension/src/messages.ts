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
 * Voice — push-to-talk modes, mic recovery, restricted pages
 * ------------------------------------------------------------------ */

/**
 * How the push-to-talk shortcut behaves.
 *
 *  - `hold`   — the classic: keep the key down while you speak, release to send.
 *  - `toggle` — press once to start; the offscreen recorder then stops on its
 *               own after ~1.2 s of silence (`SILENCE_STOP_MS` /
 *               `SILENCE_RMS_THRESHOLD` / `MAX_RECORDING_MS` are documented
 *               constants in `entrypoints/offscreen/main.ts`), press again to
 *               stop immediately.
 *
 * `chrome.commands` has NO key-up event, so a *browser-level* shortcut can only
 * ever be a toggle. `hold` is only reachable in a page that already receives
 * the keydown/keyup pair (the bubble and the side panel — see `src/shortcut.ts`).
 */
export type VoiceMode = 'hold' | 'toggle';

export const DEFAULT_VOICE_MODE: VoiceMode = 'hold';

/** Why the offscreen recorder stopped (or wants to stop) by itself. */
export type AutoStopReason = 'silence' | 'max-duration' | 'no-speech';

/** Why `getUserMedia` failed, in terms the background can act on. */
export type MicErrorReason = 'not-allowed' | 'no-device' | 'device-busy' | 'unknown';

/** What the offscreen recorder answers to `diggy:offscreen-start`. */
export interface OffscreenStartResult {
  ok: boolean;
  error?: string;
  /** Set when `ok` is false, so the background can offer the permission page. */
  reason?: MicErrorReason;
}

/**
 * Voice copy this worker had to own.
 *
 * NOTE (one-home rule): `src/strings.ts` is the canonical home for user-facing
 * text, but it sits outside this worker's file ownership. These strings are the
 * single source for every new voice surface (the in-page bubble, the mic
 * permission page, and the Settings first-run notice which imports
 * `VOICE_COPY.firstRunNotice`) and should be moved into `STRINGS.voice`
 * verbatim by whoever owns `src/strings.ts`.
 */
export const VOICE_COPY = {
  /** Bubble / background: Chrome blocked the microphone for this origin. */
  micBlocked:
    'Microphone blocked — I opened a small Diggy tab. Click “Allow microphone” there and I will start listening again by itself.',
  /** Permission page: heading. */
  permissionTitle: 'Allow Diggy to use your microphone',
  /** Permission page: why the extra page is needed. */
  permissionBody:
    'A web page cannot ask for your microphone on Diggy’s behalf, but this extension page can — it takes one click and the browser remembers it. Nothing is recorded here.',
  /** Permission page: the only action. */
  permissionButton: 'Allow microphone',
  /** Permission page: waiting for the browser's prompt. */
  permissionAsking: 'Waiting for the browser… choose “Allow” when it asks.',
  /** Permission page: granted, the recorder is being started again. */
  permissionRetrying: '✅ Microphone allowed — starting Diggy…',
  /** Permission page: granted but no recording was waiting. */
  permissionGranted: '✅ Microphone allowed — you can close this tab.',
  /** Permission page: still blocked. */
  permissionDenied:
    'The microphone is still blocked. Click the 🔒 in the address bar, allow the microphone for Diggy, then try again.',
  /** Permission page: the browser exposes no microphone API. */
  permissionNoSupport: 'This browser cannot access the microphone.',
  /** Permission page: reassurance that this is a one-off. */
  permissionOnce: 'You only have to do this once for the whole extension.',
  /** Bubble: a page class Chrome never injects content scripts into. */
  restrictedPage:
    'This is a browser page (settings, Web Store or the built-in PDF viewer), so extensions cannot run here. Open the Diggy side panel and click 🎙 to talk instead.',
  /** Bubble: hint while a toggle-mode recording is running. */
  listeningToggle:
    'Press the shortcut again to send — or stop talking for a moment and I will send it myself.',
  /**
   * Settings: the first-run notice. One paragraph, English only. Says where the
   * audio goes (Groq, for transcription) and how replies are spoken (the
   * browser's own speech synthesis, with text-only as the fallback).
   */
  firstRunNotice:
    'Voice input: Diggy records only while the push-to-talk shortcut is active and sends that audio to Groq for transcription — it is used to turn your speech into text and is not kept by Diggy. Spoken replies use your browser’s own speech synthesis (text-to-speech); nothing is sent anywhere for that, and if your browser has no voice available the reply simply stays on screen as text in the bubble and the side panel.',
} as const;

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
  /**
   * Let the offscreen recorder stop by itself on silence (toggle mode) instead
   * of waiting for a key-up. Omitted = the background decides from the stored
   * `voiceMode` setting.
   */
  autoStop?: boolean;
}

/** Push-to-talk: stop recording, transcribe with Groq Whisper, then run the agent. */
export interface RecStopMessage {
  type: 'diggy:rec-stop';
}

/** Push-to-talk: pre-warm the offscreen recorder so the first press is instant. */
export interface RecWarmMessage {
  type: 'diggy:rec-warm';
}

/**
 * Any context → background: the microphone is blocked, so open the extension
 * page (`permissions.html`) that can ask for it with a real user gesture.
 */
export interface MicPermissionRequestMessage {
  type: 'diggy:mic-permission-request';
  /** Which surface asked (diagnostics only). */
  source?: 'bubble' | 'sidepanel' | 'offscreen';
}

/**
 * The permission page → background: the outcome of its `getUserMedia()` call.
 * On a success the background retries the recording exactly once.
 */
export interface MicPermissionResultMessage {
  type: 'diggy:mic-permission-result';
  ok: boolean;
  error?: string;
}

/**
 * Offscreen recorder → background: silence (or the hard cap) was reached and
 * the recording should be stopped and sent. The recorder deliberately does NOT
 * stop itself — the background keeps a single stop path so the clip can never
 * be dropped or double-stopped.
 */
export interface OffscreenSilenceMessage {
  type: 'diggy:offscreen-silence';
  reason: AutoStopReason;
}

/** Background → content script: the recorder auto-stopped, update the UI only. */
export interface RecAutoStopMessage {
  type: 'diggy:rec-auto-stop';
  reason: AutoStopReason;
}

/** Content script → background: open this URL in a new tab (reliable). */
export interface OpenUrlMessage {
  type: 'diggy:open-url';
  url: string;
}

/**
 * Read a URL from the user's OWN signed-in tab.
 *
 * LinkedIn, Gmail and friends show a login wall to an anonymous fetch but real
 * content to the tab the user is already signed into, so those have to be read
 * through the browser the user is using.
 */
export interface ReadTabMessage {
  type: 'diggy:read-tab';
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
  | MicPermissionRequestMessage
  | MicPermissionResultMessage
  | OffscreenSilenceMessage
  | RecAutoStopMessage
  | OpenUrlMessage
  | ReadTabMessage
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

export function isMicPermissionRequest(message: unknown): message is MicPermissionRequestMessage {
  return isObject(message) && message.type === 'diggy:mic-permission-request';
}

export function isMicPermissionResult(message: unknown): message is MicPermissionResultMessage {
  return isObject(message) && message.type === 'diggy:mic-permission-result' && typeof message.ok === 'boolean';
}

export function isOffscreenSilence(message: unknown): message is OffscreenSilenceMessage {
  return isObject(message) && message.type === 'diggy:offscreen-silence';
}

export function isRecAutoStop(message: unknown): message is RecAutoStopMessage {
  return isObject(message) && message.type === 'diggy:rec-auto-stop';
}

export function isOpenUrl(message: unknown): message is OpenUrlMessage {
  return isObject(message) && message.type === 'diggy:open-url' && typeof message.url === 'string';
}

export function isReadTab(message: unknown): message is ReadTabMessage {
  return isObject(message) && message.type === 'diggy:read-tab' && typeof message.url === 'string';
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
export async function recStart(
  autoStop?: boolean,
): Promise<{ ok?: boolean; error?: string; needsPermission?: boolean }> {
  // `autoStop` is what makes toggle mode work: the offscreen recorder ends the
  // clip on silence instead of waiting for a key-up that a global command never
  // sends. Left undefined the background falls back to the stored `voiceMode`.
  const message: RecStartMessage =
    autoStop === undefined ? { type: 'diggy:rec-start' } : { type: 'diggy:rec-start', autoStop };
  return (
    (await sendWithRetry<{ ok?: boolean; error?: string; needsPermission?: boolean }>(message)) ?? {
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

/**
 * Ask the background to open the mic permission page (`permissions.html`).
 *
 * Deliberately a single send with NO retry: `sendWithRetry` would deliver the
 * message up to three times and open three tabs.
 */
export async function requestMicPermission(
  source: MicPermissionRequestMessage['source'] = 'bubble',
): Promise<{ ok?: boolean; error?: string }> {
  const message: MicPermissionRequestMessage = { type: 'diggy:mic-permission-request', source };
  try {
    const response = (await browser.runtime.sendMessage(message)) as
      | { ok?: boolean; error?: string }
      | undefined;
    return response ?? {};
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'no-answer' };
  }
}

/**
 * Permission page → background: report the outcome of its `getUserMedia()`.
 *
 * The background retries the recording once when `ok` is true and answers with
 * the retry result, so the page can say "starting Diggy…" or stay put with the
 * reason it is still blocked.
 */
export async function signalMicPermission(
  ok: boolean,
  error?: string,
): Promise<{ ok?: boolean; error?: string }> {
  const message: MicPermissionResultMessage = { type: 'diggy:mic-permission-result', ok, error };
  try {
    const response = (await browser.runtime.sendMessage(message)) as
      | { ok?: boolean; error?: string }
      | undefined;
    return response ?? {};
  } catch (caught) {
    return { ok: false, error: caught instanceof Error ? caught.message : 'no-answer' };
  }
}

/**
 * Read the push-to-talk mode straight from `chrome.storage.local`.
 *
 * Defensive by design: the Settings shape lives in `src/storage.ts`, which this
 * worker does not own, so anything that is not exactly `'toggle'` falls back to
 * `'hold'` — today's behaviour, unchanged.
 */
export async function readVoiceMode(): Promise<VoiceMode> {
  try {
    const store = (await browser.storage.local.get('diggy:settings')) as Record<string, unknown>;
    const settings = store['diggy:settings'] as { voiceMode?: unknown } | undefined;
    return settings?.voiceMode === 'toggle' ? 'toggle' : DEFAULT_VOICE_MODE;
  } catch {
    return DEFAULT_VOICE_MODE;
  }
}

/**
 * Pages where Chrome never injects a content script, so there is no in-page
 * bubble to hold the shortcut — the side panel's 🎙 button is the documented
 * fallback there.
 */
const RESTRICTED_URL_PATTERNS: readonly RegExp[] = [
  /^chrome:\/\//i,
  /^chrome-search:\/\//i,
  /^chrome-untrusted:\/\//i,
  /^chrome-extension:\/\//i,
  /^devtools:\/\//i,
  /^edge:\/\//i,
  /^about:/i,
  /^view-source:/i,
  /^https:\/\/chrome\.google\.com\/webstore/i,
  /^https:\/\/chromewebstore\.google\.com/i,
  /^https:\/\/microsoftedge\.microsoft\.com\/addons/i,
  /^https:\/\/addons\.mozilla\.org/i,
];

/**
 * Is this a page the extension cannot be part of?
 *
 * `chrome://` (settings, flags, extensions), the Web Stores, `about:` pages,
 * `view-source:`, DevTools, other extensions' pages and the built-in PDF viewer
 * — which renders on a `chrome-extension://` origin, with the `.pdf` test
 * covering URLs Chrome hands to that viewer.
 */
export function isRestrictedUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  const value = url.trim();
  if (!value) return false;
  if (RESTRICTED_URL_PATTERNS.some((pattern) => pattern.test(value))) return true;
  return /\.pdf(\?|#|$)/i.test(value);
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
