/**
 * Diggy background service worker.
 *
 * Three jobs:
 *  1. Message router — side panel ⇄ content scripts (`diggy:content-call`).
 *  2. WebSocket bridge client to the desktop companion (hello/welcome handshake,
 *     exponential-backoff reconnect, graceful when no desktop app is running).
 *  3. `chrome.alarms` reminder fallback + `chrome.notifications`.
 */
import { BRIDGE_PROTOCOL_VERSION, type Reminder } from '@diggy/shared';
import { WsBridgeClient } from '../src/bridge/ws-client';
import {
  isAgentAsk,
  isBridgeConnect,
  isBridgeDisconnect,
  isContentCall,
  isFillApply,
  isGoogleCheck,
  isRecStart,
  isRecStop,
  isRecWarm,
  isWatchCheck,
  type AgentAskMessage,
  type BridgeEventMessage,
  type BridgeStatusRequest,
  type BridgeStatusResponse,
  type ContentCallMessage,
  type ContentMethod,
  type ContentResponse,
  type NotifyMessage,
  type ScheduleReminderMessage,
} from '../src/messages';
import { applyFillToTab, askDiggy } from '../src/agent';
import { getReminders, getSettings, updateReminder, watchSettings } from '../src/storage';
import { getWatches, updateWatch } from '../src/watches';
import { checkWatch } from '../src/web';
import { addSeenIds, getSeenIds } from '../src/google';
import { readCalendarSmart, readInboxSmart } from '../src/accounts';
import { latestVideos, parseVideoRequest, videoCard } from '../src/cards';

const ALARM_TICK = 'diggy:reminder-tick';
const ALARM_PREFIX = 'diggy:reminder:';
const WATCH_TICK = 'diggy:watch-tick';
const WATCH_PERIOD_MINUTES = 5;
const GOOGLE_TICK = 'diggy:google-tick';
const CONTEXT_MENU_ID = 'diggy-ask';

interface SidePanelApi {
  open(options: { tabId?: number; windowId?: number }): Promise<void>;
  setPanelBehavior?(options: { openPanelOnActionClick?: boolean }): Promise<void>;
}

let bridge: WsBridgeClient | null = null;
let bridgeUrl = '';
let contextMenuReady = false;
let bootstrapped = false;

/* ------------------------------------------------------------------ *
 * Small guards
 * ------------------------------------------------------------------ */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isBridgeStatusRequest(message: unknown): message is BridgeStatusRequest {
  return isObject(message) && message.type === 'diggy:bridge-status-request';
}

function isScheduleReminder(message: unknown): message is ScheduleReminderMessage {
  return isObject(message) && message.type === 'diggy:reminder-schedule';
}

function isNotify(message: unknown): message is NotifyMessage {
  return isObject(message) && message.type === 'diggy:notify';
}

function fail(method: ContentMethod, error: string): ContentResponse {
  return { type: 'diggy:content-response', ok: false, method, error };
}

/* ------------------------------------------------------------------ *
 * Router: side panel → active tab → content script
 * ------------------------------------------------------------------ */

async function activeTabId(): Promise<number | undefined> {
  try {
    const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    return tabs[0]?.id;
  } catch {
    return undefined;
  }
}

async function forwardToContent(call: ContentCallMessage): Promise<ContentResponse> {
  try {
    const tabId = call.tabId ?? (await activeTabId());
    if (tabId == null) return fail(call.method, 'No active tab to talk to');
    const response = (await browser.tabs.sendMessage(tabId, {
      type: 'diggy:content-exec',
      method: call.method,
      params: call.params,
    })) as ContentResponse | undefined;
    if (!response || response.type !== 'diggy:content-response') {
      return fail(call.method, 'The content script did not respond');
    }
    return response;
  } catch (error) {
    return fail(call.method, error instanceof Error ? error.message : 'content-unreachable');
  }
}

function handleMessage(
  message: unknown,
  sender?: { tab?: { id?: number } },
): Promise<unknown> | undefined {
  if (isContentCall(message)) return forwardToContent(message);
  if (isAgentAsk(message)) {
    void runAsk(message, sender?.tab?.id);
    return Promise.resolve({ ok: true });
  }
  if (isFillApply(message)) {
    const tabId = sender?.tab?.id;
    return applyFillToTab(tabId, message.fields ?? []).then(
      (result) => ({ ok: true, result }),
      (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : 'fill-failed' }),
    );
  }
  if (isWatchCheck(message)) {
    return checkWatches(message.id).then((result) => ({ ok: true, ...result }));
  }
  if (isGoogleCheck(message)) {
    return checkGoogle().then((result) => ({ ok: true, ...result }));
  }
  if (isRecStart(message)) {
    return beginVoice();
  }
  if (isRecStop(message)) {
    return finishVoice(sender?.tab?.id);
  }
  if (isRecWarm(message)) {
    return (async () => {
      if (!(await ensureOffscreen())) {
        return { ok: false, error: 'Recording is unavailable in this browser.' };
      }
      try {
        const warmed = (await browser.runtime.sendMessage({ type: 'diggy:offscreen-warm' })) as
          | { ok?: boolean; error?: string }
          | undefined;
        return warmed ?? { ok: false, error: 'No response from the recorder.' };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Microphone unavailable.' };
      }
    })();
  }
  if (isBridgeConnect(message)) {
    return ensureBridge().then(
      () => ({ ok: true }),
      (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : 'bridge-failed' }),
    );
  }
  if (isBridgeDisconnect(message)) {
    bridge?.disconnect();
    bridge = null;
    return Promise.resolve({ ok: true });
  }
  if (isBridgeStatusRequest(message)) {
    const status: BridgeStatusResponse = {
      type: 'diggy:bridge-status-response',
      connected: bridge?.connected ?? false,
      url: bridgeUrl,
      protocol: BRIDGE_PROTOCOL_VERSION,
    };
    return Promise.resolve(status);
  }
  if (isScheduleReminder(message)) {
    scheduleReminderAlarm(message.reminder);
    return undefined;
  }
  if (isNotify(message)) {
    void showNotification(message.title, message.body);
    return undefined;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * In-page bot: re-mount after an extension reload
 * ------------------------------------------------------------------ */

/**
 * Re-mount the bot in tabs that were already open when the extension reloaded.
 *
 * Reloading Diggy makes every existing content script's `onInvalidated` cleanup
 * run (it removes the bot), and the browser does not inject the new content
 * script into tabs that are already loaded — so the bot would stay gone until a
 * manual page refresh. This injects it back.
 */
async function reinjectIntoOpenTabs(): Promise<void> {
  try {
    const tabs = await browser.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    await Promise.all(
      tabs.map((tab) =>
        tab.id == null
          ? Promise.resolve()
          : browser.scripting
              .executeScript({ target: { tabId: tab.id }, files: ['content-scripts/content.js'] })
              .catch(() => undefined),
      ),
    );
  } catch {
    /* best effort — never block startup */
  }
}

/* ------------------------------------------------------------------ *
 * Agent (voice / push-to-talk brain)
 * ------------------------------------------------------------------ */

async function runAsk(message: AgentAskMessage, senderTabId?: number): Promise<void> {
  const tabId = message.tabId ?? senderTabId ?? (await activeTabId());
  const send = (payload: unknown): void => {
    if (tabId == null) return;
    void browser.tabs.sendMessage(tabId, payload).catch(() => undefined);
  };

  send({ type: 'diggy:agent-delta', text: '' });

  // "…ka latest video" → resolve it here so the bubble can show a video card
  // (thumbnail + Play) instead of a bare sentence. If that fails we do NOT give
  // up: the brain has searchWeb/readPage, so hand it a hint and let it search.
  let hint = '';
  const channel = parseVideoRequest(message.text);
  if (channel) {
    try {
      const video = (await latestVideos(channel, 1))[0];
      if (video) {
        send({
          type: 'diggy:agent-done',
          text: `Ye raha ${channel} ka latest video 👇`,
          ok: true,
          card: videoCard({
            videoId: video.videoId,
            title: video.title,
            url: video.url,
            thumbnail: video.thumbnail,
            published: video.published,
            channel,
          }),
        });
        return;
      }
    } catch {
      /* leave it to the brain */
    }
    hint = `\n\n(System note: the user wants ${channel}'s latest YouTube video. Use searchWeb to find the watch link, then answer with it.)`;
  }

  const result = await askDiggy(`${message.text}${hint}`, {
    tabId,
    onDelta: (_chunk, full) => send({ type: 'diggy:agent-delta', text: full }),
  });
  send({ type: 'diggy:agent-done', text: result.text, ok: result.ok, spoke: result.spoke });
}

/* ------------------------------------------------------------------ *
 * Voice input (push-to-talk) — offscreen recorder + Groq Whisper
 * ------------------------------------------------------------------ */

interface OffscreenApi {
  hasDocument?: () => Promise<boolean>;
  createDocument: (options: unknown) => Promise<void>;
}

let offscreenReady = false;

/**
 * Wait until the offscreen document's message listener is actually up.
 *
 * `createDocument()` resolves before the document's script has registered its
 * listener, so sending work immediately fails with "receiving end does not
 * exist" — the reason the first push-to-talk used to do nothing.
 */
async function offscreenPing(timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const pong = (await browser.runtime.sendMessage({ type: 'diggy:offscreen-ping' })) as
        | { ok?: boolean }
        | undefined;
      if (pong?.ok) return true;
    } catch {
      /* not listening yet */
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

async function ensureOffscreen(): Promise<boolean> {
  const api = (browser as unknown as { offscreen?: OffscreenApi }).offscreen;
  if (!api) return false;
  try {
    if (api.hasDocument && (await api.hasDocument())) {
      if (await offscreenPing(1200)) {
        offscreenReady = true;
        return true;
      }
    }
  } catch {
    /* older browsers */
  }
  if (offscreenReady) return true;
  try {
    await api.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Record your voice command so Diggy can transcribe it locally.',
    });
  } catch {
    return false;
  }
  if (!(await offscreenPing())) return false;
  offscreenReady = true;
  return true;
}

/** Send the recorded audio to Groq Whisper and return the transcript. */
async function transcribe(base64: string, mime: string): Promise<string> {
  const settings = await getSettings();
  const key = (settings.groqKey || '').trim();
  if (!key) throw new Error('Add a Groq API key in ⚙ settings to use voice input.');

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

  const extension = mime.includes('mp4') ? 'mp4' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime }), `voice.${extension}`);
  form.append('model', 'whisper-large-v3');
  form.append('response_format', 'json');

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Transcription failed (${response.status}) ${detail.slice(0, 120)}`);
  }
  const payload = (await response.json()) as { text?: string };
  return (payload.text ?? '').trim();
}

/* ------------------------------------------------------------------ *
 * Voice — start / stop, shared by the shortcut, the panel and commands
 * ------------------------------------------------------------------ */

/** Start recording. */
async function beginVoice(): Promise<{ ok: boolean; error?: string }> {
  if (!(await ensureOffscreen())) {
    return { ok: false, error: 'Recording is unavailable in this browser.' };
  }
  try {
    const started = (await browser.runtime.sendMessage({ type: 'diggy:offscreen-start' })) as
      | { ok?: boolean; error?: string }
      | undefined;
    if (started?.ok) return { ok: true };
    return {
      ok: false,
      error: started?.error ?? 'Microphone unavailable — click 🎙 in the side panel once to allow it.',
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Microphone unavailable.' };
  }
}

/** Stop, transcribe with Whisper, then run the brain. */
async function finishVoice(tabId?: number): Promise<{ ok: boolean; text?: string; error?: string }> {
  const recorded = (await browser.runtime
    .sendMessage({ type: 'diggy:offscreen-stop' })
    .catch(() => ({ ok: false, error: 'Microphone unavailable.' }))) as
    | { ok?: boolean; base64?: string; mime?: string; error?: string }
    | undefined;
  if (!recorded?.ok || !recorded.base64) {
    return { ok: false, error: recorded?.error ?? 'No audio captured — try holding the key a little longer.' };
  }
  try {
    const text = await transcribe(recorded.base64, recorded.mime ?? 'audio/webm');
    if (!text) return { ok: false, error: 'I could not hear anything.' };
    // Show the user what was heard before the reply streams in.
    if (tabId != null) {
      void browser.tabs.sendMessage(tabId, { type: 'diggy:agent-heard', text }).catch(() => undefined);
    }
    void runAsk({ type: 'diggy:ask', text }, tabId);
    return { ok: true, text };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Browser-level shortcut (`commands`).
 *
 * A page never sees a chord another extension has already claimed as a global
 * command, so this is the guaranteed keyboard path. Commands have no key-up, so
 * it toggles: press to start, press again to send.
 */
let commandRecording = false;

async function toggleVoiceCommand(): Promise<void> {
  const tabId = (await activeTabId()) ?? undefined;
  const tell = (payload: unknown): void => {
    if (tabId == null) return;
    void browser.tabs.sendMessage(tabId, payload).catch(() => undefined);
  };

  if (commandRecording) {
    commandRecording = false;
    const result = await finishVoice(tabId);
    if (!result.ok) tell({ type: 'diggy:agent-done', text: result.error ?? 'Voice failed.', ok: false });
    return;
  }

  const started = await beginVoice();
  if (!started.ok) {
    tell({ type: 'diggy:agent-done', text: started.error ?? 'Microphone unavailable.', ok: false });
    return;
  }
  commandRecording = true;
  tell({ type: 'diggy:agent-delta', text: '🎙 Listening… press the shortcut again to send.' });
}

/* ------------------------------------------------------------------ *
 * Reminders + notifications
 * ------------------------------------------------------------------ */

async function showNotification(title: string, body?: string): Promise<void> {
  try {
    await browser.notifications.create({ type: 'basic', title, message: body ?? 'Diggy reminder' });
  } catch {
    /* notifications are best-effort */
  }
}

function scheduleReminderAlarm(reminder: Reminder): void {
  const due = new Date(reminder.dueAt).getTime();
  if (Number.isNaN(due)) return;
  browser.alarms.create(`${ALARM_PREFIX}${reminder.id}`, { when: Math.max(due, Date.now() + 1000) });
}

/**
 * A reminder is due — tell the user loudly.
 *
 * Notification + the in-page bubble (which also speaks it) + a happy mood and
 * the celebrate animation, so it feels like the bot is excited for you rather
 * than a silent note.
 */
async function fireReminder(reminder: Reminder): Promise<void> {
  const at = new Date(reminder.dueAt);
  const time = Number.isNaN(at.getTime())
    ? ''
    : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const note = reminder.notes?.trim();
  await showNotification(
    `⏰ ${reminder.title}`,
    note || (time ? `${time} ka reminder — abhi!` : 'Abhi ka time hai!'),
  );

  const tabId = await activeTabId();
  if (tabId != null) {
    const text = `⏰ ${reminder.title} — ${time ? `${time} ho gaya` : 'time ho gaya'}! ${note ?? 'Ab ye kaam karna hai.'}`;
    const send = (payload: unknown): void => {
      void browser.tabs.sendMessage(tabId, payload).catch(() => undefined);
    };
    // The bubble shows this AND speaks it (spoke is not set).
    send({ type: 'diggy:agent-done', text, ok: true });
    send({ type: 'diggy:content-exec', method: 'setMood', params: { mood: 'happy' } });
    send({ type: 'diggy:content-exec', method: 'playAnim', params: { state: 'celebrate' } });
  }

  await updateReminder(reminder.id, { status: 'done' });
}

async function checkDueReminders(): Promise<void> {
  const now = Date.now();
  const reminders = await getReminders();
  for (const reminder of reminders) {
    if (reminder.status !== 'pending') continue;
    const due = new Date(reminder.dueAt).getTime();
    if (Number.isNaN(due) || due > now) continue;
    await fireReminder(reminder);
  }
}

async function handleAlarm(alarm: { name: string }): Promise<void> {
  if (alarm.name === WATCH_TICK) {
    await checkWatches();
    return;
  }
  if (alarm.name === GOOGLE_TICK) {
    await checkGoogle();
    return;
  }
  if (alarm.name === ALARM_TICK) {
    await checkDueReminders();
    return;
  }
  if (alarm.name.startsWith(ALARM_PREFIX)) {
    const id = alarm.name.slice(ALARM_PREFIX.length);
    const reminder = (await getReminders()).find((item) => item.id === id);
    if (reminder && reminder.status === 'pending') await fireReminder(reminder);
  }
}

/* ------------------------------------------------------------------ *
 * Watched sites — poll the web and cheer when something shows up
 * ------------------------------------------------------------------ */

let watching = false;

async function announceInPage(text: string, celebrate: boolean): Promise<void> {
  const tabId = await activeTabId();
  if (tabId == null) return;
  const send = (method: string, params: unknown): void => {
    void browser.tabs.sendMessage(tabId, { type: 'diggy:content-exec', method, params }).catch(() => undefined);
  };
  send('speak', { text });
  if (celebrate) {
    send('setMood', { mood: 'happy' });
    send('playAnim', { state: 'celebrate' });
  }
}

/** Check every enabled watch (or one by id) and notify on changes/keyword hits. */
async function checkWatches(id?: string): Promise<{ checked: number; alerts: string[] }> {
  if (watching) return { checked: 0, alerts: [] };
  watching = true;
  const alerts: string[] = [];
  let checked = 0;
  try {
    const list = await getWatches();
    for (const watch of list) {
      if (id && watch.id !== id) continue;
      if (!watch.enabled) continue;
      try {
        const result = await checkWatch(watch.url, watch.keyword);
        checked += 1;
        const firstRun = !watch.lastHash;
        const changed = !firstRun && result.hash !== watch.lastHash;
        const keywordHit = Boolean(watch.keyword && result.matched);

        await updateWatch(watch.id, {
          lastCheckedAt: new Date().toISOString(),
          lastHash: result.hash,
        });

        if (keywordHit) {
          const text = `🎉 ${watch.label}: I spotted "${watch.keyword}" — go check it now!`;
          alerts.push(text);
          await showNotification(`Diggy · ${watch.label}`, text);
          await announceInPage(text, true);
        } else if (changed) {
          const text = `👀 ${watch.label} just changed — worth a look.`;
          alerts.push(text);
          await showNotification(`Diggy · ${watch.label}`, text);
          await announceInPage(text, false);
        }
      } catch {
        /* a single failed check must not stop the rest */
      }
    }
  } finally {
    watching = false;
  }
  return { checked, alerts };
}

/* ------------------------------------------------------------------ *
 * Google (Gmail + Calendar) — notify the moment something important lands
 * ------------------------------------------------------------------ */

let googleChecking = false;

const IMPORTANT = /offer|selected|selection|shortlist|interview|schedule|deadline|last date|admit|result|congrats|congratulations/i;

async function checkGoogle(): Promise<{ emails: number; events: number; alerts: string[] }> {
  if (googleChecking) return { emails: 0, events: 0, alerts: [] };
  googleChecking = true;
  const alerts: string[] = [];
  let emails = 0;
  let events = 0;
  try {
    const settings = await getSettings();
    const seen = new Set(await getSeenIds());
    const freshSeen: string[] = [];

    if (settings.gmailWatch) {
      try {
        const messages = await readInboxSmart({ max: 8 });
        const fresh = messages.filter((message) => !seen.has(`m:${message.id}`));
        emails = fresh.length;
        for (const message of fresh) {
          const sender = message.from.replace(/<.*>/, '').replace(/"/g, '').trim() || 'New mail';
          const excited = IMPORTANT.test(`${message.subject} ${message.snippet}`);
          const text = `${excited ? '🎉' : '📧'} ${sender}: ${message.subject}`;
          alerts.push(text);
          await showNotification(excited ? 'Diggy · important email' : 'Diggy · new email', text);
          await announceInPage(text, excited);
          freshSeen.push(`m:${message.id}`);
        }
      } catch {
        /* Gmail not connected / not signed in */
      }
    }

    if (settings.calendarWatch) {
      try {
        const upcoming = await readCalendarSmart({ days: 1, max: 10 });
        events = upcoming.length;
        const now = Date.now();
        for (const event of upcoming) {
          const start = new Date(event.start).getTime();
          if (!Number.isFinite(start)) continue;
          const minutes = (start - now) / 60000;
          if (minutes > -1 && minutes <= 20 && !seen.has(`e:${event.id}`)) {
            const when = minutes <= 0 ? 'starting now' : `in ${Math.max(1, Math.round(minutes))} min`;
            const text = `⏰ ${event.summary} — ${when}`;
            alerts.push(text);
            await showNotification('Diggy · calendar', text);
            await announceInPage(text, false);
            freshSeen.push(`e:${event.id}`);
          }
        }
      } catch {
        /* Calendar not connected */
      }
    }

    if (freshSeen.length > 0) await addSeenIds(freshSeen);
  } catch {
    /* Google hiccups must never break the worker */
  } finally {
    googleChecking = false;
  }
  return { emails, events, alerts };
}

/* ------------------------------------------------------------------ *
 * Side panel + context menu
 * ------------------------------------------------------------------ */

function getSidePanel(): SidePanelApi | undefined {
  return (browser as unknown as { sidePanel?: SidePanelApi }).sidePanel;
}

async function openSidePanel(tabId?: number): Promise<void> {
  const api = getSidePanel();
  if (!api) return;
  try {
    const target = tabId ?? (await activeTabId());
    if (target != null) await api.open({ tabId: target });
    else await api.open({});
  } catch {
    /* requires a user gesture / supported browser */
  }
}

async function setupSidePanel(): Promise<void> {
  const api = getSidePanel();
  try {
    await api?.setPanelBehavior?.({ openPanelOnActionClick: true });
  } catch {
    /* older browsers */
  }
}

async function setupContextMenu(): Promise<void> {
  // Context menus persist across service-worker restarts, so create exactly once
  // per worker lifetime and swallow the "duplicate id" lastError.
  if (contextMenuReady) return;
  contextMenuReady = true;
  try {
    await browser.contextMenus.removeAll();
  } catch {
    /* ignore */
  }
  try {
    await browser.contextMenus.create({ id: CONTEXT_MENU_ID, title: 'Ask Diggy', contexts: ['all'] });
  } catch {
    /* already exists — fine */
  }
  // Some Chromium builds surface the failure as an unchecked runtime.lastError.
  void browser.runtime.lastError;
}

/* ------------------------------------------------------------------ *
 * Desktop bridge
 * ------------------------------------------------------------------ */

function broadcastBridgeEvent(message: BridgeEventMessage): void {
  void browser.runtime.sendMessage(message).catch(() => undefined);
}

async function ensureBridge(): Promise<void> {
  if (bridge) {
    bridge.connect();
    return;
  }
  try {
    const settings = await getSettings();
    bridgeUrl = settings.bridgeUrl;
    bridge = new WsBridgeClient({
      url: settings.bridgeUrl,
      token: settings.bridgeToken,
      role: 'extension',
      protocol: BRIDGE_PROTOCOL_VERSION,
      onEvent: (event) =>
        broadcastBridgeEvent({ type: 'diggy:bridge-event', event: event.event, payload: event.payload }),
      // Swallow errors — no desktop companion simply means "keep reconnecting".
      onError: () => undefined,
    });
    bridge.connect();
  } catch {
    /* never crash the worker */
  }
}

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

async function bootstrap(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;

  browser.alarms.create(ALARM_TICK, { periodInMinutes: 1 });
  // Poll watched sites on a schedule so notifications land on time.
  browser.alarms.create(WATCH_TICK, { periodInMinutes: WATCH_PERIOD_MINUTES, delayInMinutes: 1 });
  // Poll Gmail + Calendar on the same cadence when connected.
  browser.alarms.create(GOOGLE_TICK, { periodInMinutes: WATCH_PERIOD_MINUTES, delayInMinutes: 2 });

  for (const reminder of await getReminders()) {
    if (reminder.status === 'pending') scheduleReminderAlarm(reminder);
  }

  await setupContextMenu();
  await setupSidePanel();
  // The desktop companion bridge is intentionally NOT connected automatically:
  // the companion is not built yet, so connecting only spams the console with
  // ERR_CONNECTION_REFUSED. It is started on demand (see watchSettings / the
  // side panel's bridge status request).
}

export default defineBackground(() => {
  // Listeners are registered synchronously, as MV3 requires.
  browser.runtime.onMessage.addListener((message: unknown, sender: unknown) =>
    handleMessage(message, sender as { tab?: { id?: number } }),
  );
  // Browser-level shortcut: works even when the page never receives the chord
  // (another extension, or the browser itself, may have claimed it).
  browser.commands.onCommand.addListener((command) => {
    if (command === 'toggle-voice') void toggleVoiceCommand();
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    void handleAlarm(alarm);
  });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === CONTEXT_MENU_ID) void openSidePanel(tab?.id);
  });
  browser.runtime.onInstalled.addListener(() => {
    void bootstrap();
    void reinjectIntoOpenTabs();
  });
  browser.runtime.onStartup.addListener(() => {
    void bootstrap();
    void reinjectIntoOpenTabs();
  });

  // Restart the bridge if the URL/token changes.
  watchSettings((settings) => {
    if (settings.bridgeUrl !== bridgeUrl) {
      bridge?.disconnect();
      bridge = null;
      void ensureBridge();
    }
  });

  void bootstrap();
});
