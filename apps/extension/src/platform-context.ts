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

export interface FillPlan {
  fields: FillInstruction[];
  createdAt: string;
}

export interface PlatformContextOptions {
  /** Called when the model proposes a fill — show a confirm card, don't fill yet. */
  onFillPlan?: (plan: FillPlan) => void;
  onMood?: (mood: AvatarMood) => void;
  onAnim?: (state: AvatarState) => void;
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

export class PlatformToolContext implements ToolContext {
  private readonly options: PlatformContextOptions;
  private cards: RichCard[] = [];

  constructor(options: PlatformContextOptions = {}) {
    this.options = options;
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

  readPage = async (params: MethodParams['readPage']): Promise<MethodResults['readPage']> => {
    // A URL means "fetch it yourself" — never ask the user to open a tab.
    if (params.url && params.url.trim()) {
      const target = params.url.trim();

      // A video link is useless as prose. Fetch the transcript instead so the
      // model can summarise what was actually said, and fall through to the
      // normal read when there is no transcript to be had.
      const transcript = await readTranscript(target);
      if (transcript) {
        this.pushCard(linkCard(transcript.title ?? target, target, 'Transcript read by Diggy'));
        return { url: target, title: transcript.title ?? target, text: transcript.text };
      }

      const page = await extractRemote(target);
      // Some sites (LinkedIn, X, many SPAs) answer a plain fetch with an auth
      // wall or an empty shell. When the readable text is thin, ask the crawler
      // for its Jina-reader rendering before giving up — it survives far more of
      // those pages than a raw extract does.
      if (page.text.trim().length < 400) {
        const richer = await readWithReach(target);
        if (richer && richer.text.trim().length > page.text.trim().length) {
          this.pushCard(linkCard(richer.title ?? page.title, page.url, 'Page read by Diggy'));
          return { url: page.url, title: richer.title ?? page.title, text: richer.text };
        }
      }
      this.pushCard(linkCard(page.title, page.url, 'Page read by Diggy'));
      return { url: page.url, title: page.title, text: page.text };
    }
    return callContent('readPage', { includeFields: params.includeFields ?? true });
  };

  fillForm = async (params: MethodParams['fillForm']): Promise<MethodResults['fillForm']> => {
    if (params.submit) {
      throw new Error('Diggy never submits forms automatically. Ask the user to confirm.');
    }
    if (this.options.onFillPlan) {
      this.options.onFillPlan({ fields: params.fields, createdAt: new Date().toISOString() });
      return { filled: 0, skipped: params.fields.map((field) => field.fieldId) };
    }
    return applyFillPlan(params.fields);
  };

  getProfile = async (params: MethodParams['getProfile']): Promise<MethodResults['getProfile']> => {
    const profile: Profile | null = await readStoredProfile();
    if (!profile) return {};
    if (!params.section) return profile;
    return { [params.section]: profile[params.section] } as Partial<Profile>;
  };

  createReminder = async (params: MethodParams['createReminder']): Promise<MethodResults['createReminder']> => {
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

  listReminders = async (): Promise<MethodResults['listReminders']> => {
    const reminders = await getReminders();
    return reminders
      .filter((reminder) => reminder.status !== 'done')
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
  };

  crawl = async (params: MethodParams['crawl']): Promise<MethodResults['crawl']> => {
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
      if (pages.length > 0) return pages;
      throw new Error('empty crawl');
    } catch {
      // No crawler service: fetch the single page ourselves.
      const page = await fetchReadable(params.url);
      return [{ url: page.url, title: page.title, markdown: page.text }];
    }
  };

  searchWeb = async (params: MethodParams['searchWeb']): Promise<MethodResults['searchWeb']> => {
    const results = await searchRemote(params.query);
    for (const result of results.slice(0, 3)) {
      if (result.url) this.pushCard(linkCard(result.title, result.url, result.snippet));
    }
    return results;
  };

  readInbox = async (params: MethodParams['readInbox']): Promise<MethodResults['readInbox']> =>
    readInboxSmart({ query: params.query, max: params.max });

  readCalendar = async (
    params: MethodParams['readCalendar'],
  ): Promise<MethodResults['readCalendar']> =>
    readCalendarSmart({ days: params.days, max: params.max });

  notify = async (params: MethodParams['notify']): Promise<MethodResults['notify']> => {
    const message: NotifyMessage = { type: 'diggy:notify', title: params.title, body: params.body };
    try {
      await browser.runtime.sendMessage(message);
    } catch {
      /* optional */
    }
  };

  speak = async (params: MethodParams['speak']): Promise<MethodResults['speak']> => {
    const { voiceEnabled } = await getSettings();
    if (voiceEnabled) speakText(params.text);
  };

  setMood = async (params: MethodParams['setMood']): Promise<MethodResults['setMood']> => {
    this.options.onMood?.(params.mood);
    await safeContent('setMood', { mood: params.mood });
  };

  playAnim = async (params: MethodParams['playAnim']): Promise<MethodResults['playAnim']> => {
    this.options.onAnim?.(params.state);
    await safeContent('playAnim', { state: params.state });
  };
}
