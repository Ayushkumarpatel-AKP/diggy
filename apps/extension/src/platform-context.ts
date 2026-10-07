/**
 * Platform tool context for the extension side panel.
 *
 * Implements `@diggy/core`'s {@link ToolContext}: every method the LLM can call
 * is delegated to the right place — page operations go to the active tab's
 * content script, reminders/notifications go through the background worker, the
 * profile comes from local storage, and crawling hits the local crawler service.
 *
 * `fillForm` deliberately **stages a plan** (instead of filling) so the UI can
 * show a confirm card first. Nothing is ever submitted.
 *
 * **Policy gate.** Every method consults {@link RunContext.guardToolCall} before
 * it acts:
 *   - `deny`  → a refusal card is pushed and the method performs **nothing**;
 *   - `confirm` → a {@link RichCard} carrying the exact payload and destination
 *     is pushed and the method performs **nothing** (the user answers it, see
 *     {@link PlatformToolContext.approvePolicyConfirmation});
 *   - `allow` → the method proceeds exactly as before.
 *
 * Outward-effect tools (`fillForm`, `createReminder`, `notify`) therefore never
 * run while the run is tainted without a confirmation. Reads that pull in
 * third-party content call {@link RunContext.markUntrustedRead}, which both
 * taints the run and fences the text as untrusted DATA.
 */
import type { ToolContext } from '@diggy/core';
import {
  DEFAULT_CRAWL_DEPTH,
  DEFAULT_CRAWL_MAX_PAGES,
  type AvatarMood,
  type AvatarState,
  type FillInstruction,
  type MethodParams,
  type MethodResults,
  type Profile,
  type Reminder,
  type RichCard,
} from '@diggy/shared';
import {
  callContent,
  makeId,
  type ContentMethod,
  type ContentMethodParams,
  type ContentMethodResults,
  type NotifyMessage,
  type ScheduleReminderMessage,
} from './messages';
import { addReminder, getProfile as readStoredProfile, getReminders, getSettings } from './storage';
import { STRINGS } from './strings';
import { extractRemote, fetchReadable, searchRemote } from './web';
import { readCalendarSmart, readInboxSmart } from './accounts';
import { RunContext, policyDenyCard, type DecideResult } from './policy-host';

export interface FillPlan {
  fields: FillInstruction[];
  createdAt: string;
}

export interface PlatformContextOptions {
  /** Called when the model proposes a fill — show a confirm card, don't fill yet. */
  onFillPlan?: (plan: FillPlan) => void;
  onMood?: (mood: AvatarMood) => void;
  onAnim?: (state: AvatarState) => void;
  /**
   * The policy layer for this context. Created automatically when omitted; a
   * test may inject a pre-seeded one.
   */
  policy?: RunContext;
}

/** Speak text with the Web Speech API (best-effort). */
export function speakText(text: string): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = /[\u0900-\u097F]/.test(text) ? 'hi-IN' : 'en-US';
    utterance.rate = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  } catch {
    /* Speech synthesis is optional. */
  }
}

/** Content-script calls that must never break an agent run (e.g. chrome:// pages). */
async function safeContent<M extends ContentMethod>(
  method: M,
  params: ContentMethodParams[M],
): Promise<ContentMethodResults[M] | undefined> {
  try {
    return await callContent(method, params);
  } catch {
    return undefined;
  }
}

/** Apply a confirmed fill plan to the active tab. */
export async function applyFillPlan(fields: FillInstruction[]): Promise<MethodResults['fillForm']> {
  return callContent('fillForm', { fields });
}

/**
 * The URL of the page the user is looking at, or `undefined` when it cannot be
 * resolved.
 *
 * Used to point the policy layer at the *current* page for tools that act on it
 * without carrying a URL in their arguments (`readPage` with no url, `fillForm`)
 * — so a sensitive site is blocked for acting just as it is for reading.
 */
async function activeTabUrl(): Promise<string | undefined> {
  try {
    const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    return tabs[0]?.url;
  } catch {
    return undefined;
  }
}

function normalizeCrawl(payload: unknown): MethodResults['crawl'] {
  const list = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null && Array.isArray((payload as { pages?: unknown }).pages)
      ? ((payload as { pages: unknown[] }).pages)
      : [];
  return list
    .map((item) => {
      const page = item as { url?: string; title?: string; markdown?: string };
      return {
        url: page.url ?? '',
        title: page.title ?? '',
        markdown: page.markdown ?? '',
      };
    })
    .filter((page) => page.url.length > 0);
}

function normalizeSearch(payload: unknown): MethodResults['searchWeb'] {
  const list = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null && Array.isArray((payload as { results?: unknown }).results)
      ? ((payload as { results: unknown[] }).results)
      : [];
  return list.map((item) => {
    const result = item as { title?: string; url?: string; snippet?: string };
    return {
      title: result.title ?? '',
      url: result.url ?? '',
      snippet: result.snippet ?? '',
    };
  });
}

/** Keyless favicon lookup — gives every link card its real site logo. */
function faviconFor(url: string): string | undefined {
  try {
    const host = new URL(url).hostname;
    if (!host) return undefined;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`;
  } catch {
    return undefined;
  }
}

function newCardId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A link preview card with the page's real logo. */
function linkCard(title: string, url: string, subtitle?: string): RichCard {
  return {
    id: newCardId('link'),
    kind: 'link',
    title: title || url,
    subtitle,
    url,
    faviconUrl: faviconFor(url),
    actions: [{ id: 'open', label: 'Open', kind: 'link', value: url, variant: 'primary' }],
  };
}

/**
 * Fetch a YouTube video's transcript from the crawler service.
 *
 * A video link read as HTML is useless to the model, so for a YouTube URL we ask
 * the crawler's `/transcript` route (which delegates to agent-reach / yt-dlp) and
 * hand back real prose. Returns `undefined` — never throws — for a non-video URL
 * or when the service or its transcript backend is unavailable, so the caller
 * falls straight through to the normal page read.
 */
async function readTranscript(
  url: string,
): Promise<{ title?: string; text: string } | undefined> {
  if (!/(youtube\.com\/(watch|shorts)\b|youtu\.be\/)/i.test(url)) return undefined;
  try {
    const { crawlerUrl } = await getSettings();
    const base = crawlerUrl.replace(/\/$/, '');
    const controller = new AbortController();
    // Transcription can take a while on a long video.
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await fetch(`${base}/transcript?url=${encodeURIComponent(url)}`, {
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      const payload = (await response.json()) as { title?: string; text?: string };
      const text = payload.text?.trim();
      return text ? { title: payload.title, text } : undefined;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
}

/**
 * Read a page through Jina Reader — the same free service agent-reach's "web"
 * channel uses.
 *
 * A raw extract of LinkedIn, X or any SPA usually comes back as an auth wall or
 * an empty shell. Jina renders enough of those pages to be genuinely useful.
 * Returns `undefined` on any failure so the caller keeps what it already had.
 */
async function readWithReach(url: string): Promise<{ title?: string; text: string } | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const response = await fetch(`https://r.jina.ai/${url}`, {
        signal: controller.signal,
        headers: { accept: 'text/plain' },
      });
      if (!response.ok) return undefined;
      const raw = (await response.text()).trim();
      if (!raw) return undefined;
      const title = /^Title:\s*(.+)$/m.exec(raw)?.[1]?.trim();
      // Drop Jina's own header block, keep the prose.
      const body = raw.replace(/^(Title|URL Source|Published Time|Markdown Content):.*$/gm, '').trim();
      return { title, text: body.slice(0, 20_000) };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
}

/**
 * Sites whose real content only exists inside the user's own session.
 *
 * An anonymous fetch of any of these hits a login wall, so they are read through
 * the browser the user is already signed into instead.
 */
const SESSION_SITES =
  /(^|\.)(linkedin\.com|mail\.google\.com|x\.com|twitter\.com|reddit\.com|instagram\.com|facebook\.com|notion\.so|web\.whatsapp\.com|web\.telegram\.org|github\.com)$/i;

/**
 * Read a URL the user is signed into, from their own tab.
 *
 * Returns `undefined` for anything that is not a session site, or when the tab
 * read fails, so callers fall back to the anonymous path.
 */
async function readFromUserSession(
  url: string,
): Promise<{ title: string; text: string } | undefined> {
  try {
    if (!SESSION_SITES.test(new URL(url).hostname)) return undefined;
  } catch {
    return undefined;
  }
  try {
    const response = (await browser.runtime.sendMessage({ type: 'diggy:read-tab', url })) as
      | { ok?: boolean; title?: string; text?: string }
      | undefined;
    const text = response?.text?.trim();
    if (!response?.ok || !text) return undefined;
    return { title: response.title?.trim() || url, text };
  } catch {
    return undefined;
  }
}

export class PlatformToolContext implements ToolContext {
  private readonly options: PlatformContextOptions;
  private cards: RichCard[] = [];

  /** The policy layer for this context — the single gate for every tool call. */
  readonly policy: RunContext;

  constructor(options: PlatformContextOptions = {}) {
    this.options = options;
    this.policy = options.policy ?? new RunContext();
  }

  /**
   * Cards collected while the model worked — the panel renders them under the
   * reply so the user can *see* what happened (a link, a video, a snapshot).
   */
  pushCard(card: RichCard): void {
    this.cards.push(card);
  }

  /** Returns and clears the cards collected since the last call. */
  takeCards(): RichCard[] {
    const collected = this.cards;
    this.cards = [];
    return collected;
  }

  /* --- policy helpers ------------------------------------------------ */

  /** Push the refusal card for a denied call. */
  private deny(tool: string, decision: DecideResult): void {
    this.pushCard(policyDenyCard(tool, decision));
  }

  /**
   * Push the confirmation card for a gated call.
   *
   * `params` are the model's original arguments (replayed after approval);
   * `guardArgs` are what the guard saw (they may carry the injected page URL).
   */
  private confirm(tool: string, params: unknown, guardArgs: unknown, decision: DecideResult): void {
    this.pushCard(this.policy.confirmationCard(tool, params, guardArgs, decision));
  }

  /**
   * The user pressed **Confirm** on a policy card.
   *
   * Grants a one-shot allowance for that exact call and replays it — the method
   * re-runs, now passing the gate, and performs the action. Returns `ok: false`
   * for an unknown/expired token (nothing happens).
   */
  approvePolicyConfirmation = async (
    token: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    const pending = this.policy.approve(token);
    if (!pending) return { ok: false, error: 'This confirmation has expired. Please ask again.' };
    try {
      await this.dispatch(pending.tool, pending.params);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  /** The user pressed **Cancel** on a policy card. */
  cancelPolicyConfirmation = (token: string): void => {
    this.policy.cancel(token);
  };

  /** Re-run a previously confirmed tool call with its original arguments. */
  private async dispatch(tool: string, params: unknown): Promise<unknown> {
    switch (tool) {
      case 'readPage':
        return this.readPage(params as MethodParams['readPage']);
      case 'fillForm':
        return this.fillForm(params as MethodParams['fillForm']);
      case 'getProfile':
        return this.getProfile(params as MethodParams['getProfile']);
      case 'createReminder':
        return this.createReminder(params as MethodParams['createReminder']);
      case 'listReminders':
        return this.listReminders();
      case 'crawl':
        return this.crawl(params as MethodParams['crawl']);
      case 'searchWeb':
        return this.searchWeb(params as MethodParams['searchWeb']);
      case 'readInbox':
        return this.readInbox(params as MethodParams['readInbox']);
      case 'readCalendar':
        return this.readCalendar(params as MethodParams['readCalendar']);
      case 'notify':
        return this.notify(params as MethodParams['notify']);
      case 'speak':
        return this.speak(params as MethodParams['speak']);
      case 'setMood':
        return this.setMood(params as MethodParams['setMood']);
      case 'playAnim':
        return this.playAnim(params as MethodParams['playAnim']);
      default:
        throw new Error(`Cannot re-run an unknown tool: "${tool}".`);
    }
  }

  /* --- tools --------------------------------------------------------- */

  readPage = async (params: MethodParams['readPage']): Promise<MethodResults['readPage']> => {
    // The URL to check the policy against: the one the model asked for, or the
    // page the user is on when no URL was given.
    const target = params.url?.trim() ?? '';
    const guardUrl = target || (await activeTabUrl()) || '';
    const guardArgs = guardUrl ? { ...params, url: guardUrl } : { ...params };

    const decision = await this.policy.guardToolCall('readPage', guardArgs);
    if (decision.decision === 'deny') {
      this.deny('readPage', decision);
      return { url: guardUrl, title: 'Blocked by Diggy policy', text: decision.reason };
    }
    if (decision.decision === 'confirm') {
      this.confirm('readPage', params, guardArgs, decision);
      return { url: guardUrl, title: 'Confirmation required', text: decision.reason };
    }

    // A URL means "fetch it yourself" — never ask the user to open a tab.
    if (target) {
      const target2 = target;

      // 1. A site the user is signed into (LinkedIn, Gmail, X…): read their own
      //    tab, because the anonymous fetch would only see a login page.
      const session = await readFromUserSession(target2);
      if (session) {
        this.pushCard(linkCard(session.title, target2, 'Read from your signed-in tab'));
        const text = this.policy.markUntrustedRead('signed-in-tab', session.text, session);
        return { url: target2, title: session.title, text };
      }

      // 2. A video: fetch its transcript, not its HTML.
      const transcript = await readTranscript(target2);
      if (transcript) {
        this.pushCard(linkCard(transcript.title ?? target2, target2, 'Transcript read by Diggy'));
        const text = this.policy.markUntrustedRead('readTranscript', transcript.text, transcript);
        return { url: target2, title: transcript.title ?? target2, text };
      }

      const page = await extractRemote(target2);
      // Some sites (LinkedIn, X, many SPAs) answer a plain fetch with an auth
      // wall or an empty shell. When the readable text is thin, ask the crawler
      // for its Jina-reader rendering before giving up — it survives far more of
      // those pages than a raw extract does.
      if (page.text.trim().length < 400) {
        const richer = await readWithReach(target2);
        if (richer && richer.text.trim().length > page.text.trim().length) {
          this.pushCard(linkCard(richer.title ?? page.title, page.url, 'Page read by Diggy'));
          const text = this.policy.markUntrustedRead('readPage', richer.text, richer);
          return { url: page.url, title: richer.title ?? page.title, text };
        }
      }
      this.pushCard(linkCard(page.title, page.url, 'Page read by Diggy'));
      const text = this.policy.markUntrustedRead('readPage', page.text, page);
      return { url: page.url, title: page.title, text };
    }

    const page = await callContent('readPage', { includeFields: params.includeFields ?? true });
    const text = this.policy.markUntrustedRead('readPage', page.text, page);
    return { ...page, text };
  };

  fillForm = async (params: MethodParams['fillForm']): Promise<MethodResults['fillForm']> => {
    // Hard rule, independent of the policy layer: Diggy never submits.
    if (params.submit) {
      throw new Error('Diggy never submits forms automatically. Ask the user to confirm.');
    }

    const guardUrl = (await activeTabUrl()) || '';
    const guardArgs = guardUrl ? { ...params, url: guardUrl } : { ...params };
    const decision = await this.policy.guardToolCall('fillForm', guardArgs);
    if (decision.decision === 'deny') {
      this.deny('fillForm', decision);
      return { filled: 0, skipped: params.fields.map((field) => field.fieldId) };
    }
    if (decision.decision === 'confirm') {
      this.confirm('fillForm', params, guardArgs, decision);
      return { filled: 0, skipped: params.fields.map((field) => field.fieldId) };
    }

    if (this.options.onFillPlan) {
      this.options.onFillPlan({ fields: params.fields, createdAt: new Date().toISOString() });
      return { filled: 0, skipped: params.fields.map((field) => field.fieldId) };
    }
    return applyFillPlan(params.fields);
  };

  getProfile = async (params: MethodParams['getProfile']): Promise<MethodResults['getProfile']> => {
    const decision = await this.policy.guardToolCall('getProfile', params);
    if (decision.decision === 'deny') {
      this.deny('getProfile', decision);
      return {};
    }
    if (decision.decision === 'confirm') {
      this.confirm('getProfile', params, params, decision);
      return {};
    }

    const profile: Profile | null = await readStoredProfile();
    if (!profile) return {};
    if (!params.section) return profile;
    return { [params.section]: profile[params.section] } as Partial<Profile>;
  };

  createReminder = async (params: MethodParams['createReminder']): Promise<MethodResults['createReminder']> => {
    const decision = await this.policy.guardToolCall('createReminder', params);
    if (decision.decision === 'deny') {
      this.deny('createReminder', decision);
      return this.pendingReminder(params, `Not created — ${decision.reason}`);
    }
    if (decision.decision === 'confirm') {
      this.confirm('createReminder', params, params, decision);
      return this.pendingReminder(params, 'Not created yet — waiting for your confirmation.');
    }

    // Models drift on dates. Normalise so a reminder can ALWAYS actually fire:
    // an unparsable time becomes +10 min, and a time that has already gone is
    // pulled forward instead of silently creating a reminder that never rings.
    const parsed = new Date(params.dueAt);
    let dueAt: string;
    if (Number.isNaN(parsed.getTime())) {
      dueAt = new Date(Date.now() + 10 * 60_000).toISOString();
    } else if (parsed.getTime() <= Date.now()) {
      dueAt = new Date(Date.now() + 60_000).toISOString();
    } else {
      dueAt = parsed.toISOString();
    }

    const reminder: Reminder = {
      id: makeId('rem'),
      title: params.title,
      notes: params.notes,
      dueAt,
      status: 'pending',
      createdAt: new Date().toISOString(),
      source: 'extension',
    };
    await addReminder(reminder);
    const message: ScheduleReminderMessage = { type: 'diggy:reminder-schedule', reminder };
    try {
      await browser.runtime.sendMessage(message);
    } catch {
      /* background may be asleep; the reminder is still persisted and the
         background's 1-minute tick will pick it up */
    }

    // Show the exact time back — so the user can verify it at a glance.
    const when = new Date(dueAt);
    this.pushCard({
      id: `rem-${reminder.id}`,
      kind: 'generic',
      title: `⏰ ${reminder.title}`,
      subtitle: `Reminder set for ${when.toLocaleString(undefined, {
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        day: 'numeric',
        month: 'short',
      })}`,
      badge: 'reminder set',
      details: reminder.notes ? [{ label: 'Note', value: reminder.notes }] : undefined,
      actions: [
        { id: 'list', label: 'My reminders', kind: 'message', value: STRINGS.reminder.listAction, variant: 'ghost' },
      ],
    });
    return reminder;
  };

  /**
   * A reminder-shaped result for a gated call that did **not** create anything.
   *
   * It is never persisted and never scheduled; `notes` says why. Returning a
   * value (rather than throwing) keeps the agent run alive and lets the model
   * read the refusal.
   */
  private pendingReminder(params: MethodParams['createReminder'], notes: string): Reminder {
    return {
      id: makeId('rem'),
      title: params.title,
      notes,
      dueAt: params.dueAt,
      status: 'pending',
      createdAt: new Date().toISOString(),
      source: 'policy',
    };
  }

  listReminders = async (): Promise<MethodResults['listReminders']> => {
    const decision = await this.policy.guardToolCall('listReminders', {});
    if (decision.decision === 'deny') {
      this.deny('listReminders', decision);
      return [];
    }
    if (decision.decision === 'confirm') {
      this.confirm('listReminders', {}, {}, decision);
      return [];
    }
    const reminders = await getReminders();
    return reminders
      .filter((reminder) => reminder.status !== 'done')
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
  };

  crawl = async (params: MethodParams['crawl']): Promise<MethodResults['crawl']> => {
    const decision = await this.policy.guardToolCall('crawl', params);
    if (decision.decision === 'deny') {
      this.deny('crawl', decision);
      return [];
    }
    if (decision.decision === 'confirm') {
      this.confirm('crawl', params, params, decision);
      return [];
    }

    try {
      const { crawlerUrl } = await getSettings();
      const base = crawlerUrl.replace(/\/$/, '');
      const response = await fetch(`${base}/crawl`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: params.url,
          depth: params.depth ?? DEFAULT_CRAWL_DEPTH,
          maxPages: params.maxPages ?? DEFAULT_CRAWL_MAX_PAGES,
        }),
      });
      if (!response.ok) throw new Error(`Crawler responded with ${response.status}`);
      const pages = normalizeCrawl(await response.json());
      if (pages.length > 0) {
        return pages.map((page) => ({
          ...page,
          markdown: this.policy.markUntrustedRead('crawl', page.markdown, page),
        }));
      }
      throw new Error('empty crawl');
    } catch {
      // No crawler service: fetch the single page ourselves.
      const page = await fetchReadable(params.url);
      return [
        {
          url: page.url,
          title: page.title,
          markdown: this.policy.markUntrustedRead('crawl', page.text, page),
        },
      ];
    }
  };

  searchWeb = async (params: MethodParams['searchWeb']): Promise<MethodResults['searchWeb']> => {
    const decision = await this.policy.guardToolCall('searchWeb', params);
    if (decision.decision === 'deny') {
      this.deny('searchWeb', decision);
      return [];
    }
    if (decision.decision === 'confirm') {
      this.confirm('searchWeb', params, params, decision);
      return [];
    }

    const results = await searchRemote(params.query);
    for (const result of results.slice(0, 3)) {
      if (result.url) this.pushCard(linkCard(result.title, result.url, result.snippet));
    }
    // Snippets are third-party text: taint the run (the returned results stay
    // clean so the link cards above keep their real snippets).
    this.policy.markUntrustedRead(
      'searchWeb',
      results.map((result) => `${result.title} ${result.snippet}`).join('\n'),
      results,
    );
    return results;
  };

  readInbox = async (params: MethodParams['readInbox']): Promise<MethodResults['readInbox']> => {
    const decision = await this.policy.guardToolCall('readInbox', params);
    if (decision.decision === 'deny') {
      this.deny('readInbox', decision);
      return [];
    }
    if (decision.decision === 'confirm') {
      this.confirm('readInbox', params, params, decision);
      return [];
    }

    const messages = await readInboxSmart({ query: params.query, max: params.max });
    this.policy.markUntrustedRead(
      'readInbox',
      messages.map((message) => `${message.from}: ${message.subject} ${message.snippet}`).join('\n'),
      messages,
    );
    return messages;
  };

  readCalendar = async (
    params: MethodParams['readCalendar'],
  ): Promise<MethodResults['readCalendar']> => {
    const decision = await this.policy.guardToolCall('readCalendar', params);
    if (decision.decision === 'deny') {
      this.deny('readCalendar', decision);
      return [];
    }
    if (decision.decision === 'confirm') {
      this.confirm('readCalendar', params, params, decision);
      return [];
    }

    const events = await readCalendarSmart({ days: params.days, max: params.max });
    this.policy.markUntrustedRead(
      'readCalendar',
      events.map((event) => `${event.summary} ${event.start} ${event.location ?? ''}`).join('\n'),
      events,
    );
    return events;
  };

  notify = async (params: MethodParams['notify']): Promise<MethodResults['notify']> => {
    const decision = await this.policy.guardToolCall('notify', params);
    if (decision.decision === 'deny') {
      this.deny('notify', decision);
      return;
    }
    if (decision.decision === 'confirm') {
      this.confirm('notify', params, params, decision);
      return;
    }

    const message: NotifyMessage = { type: 'diggy:notify', title: params.title, body: params.body };
    try {
      await browser.runtime.sendMessage(message);
    } catch {
      /* optional */
    }
  };

  speak = async (params: MethodParams['speak']): Promise<MethodResults['speak']> => {
    // Consulted for consistency; speech has no outward effect, so a taint-driven
    // `confirm` does not gate it (that would silence every reply after a read).
    const decision = await this.policy.guardToolCall('speak', params);
    if (decision.decision === 'deny') return;

    const { voiceEnabled } = await getSettings();
    if (voiceEnabled) speakText(params.text);
  };

  setMood = async (params: MethodParams['setMood']): Promise<MethodResults['setMood']> => {
    // Avatar state only — no outward effect (see `speak`).
    const decision = await this.policy.guardToolCall('setMood', params);
    if (decision.decision === 'deny') return;

    this.options.onMood?.(params.mood);
    await safeContent('setMood', { mood: params.mood });
  };

  playAnim = async (params: MethodParams['playAnim']): Promise<MethodResults['playAnim']> => {
    // Avatar state only — no outward effect (see `speak`).
    const decision = await this.policy.guardToolCall('playAnim', params);
    if (decision.decision === 'deny') return;

    this.options.onAnim?.(params.state);
    await safeContent('playAnim', { state: params.state });
  };
}
