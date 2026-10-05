/**
 * The background "brain".
 *
 * Runs the LLM agent from the service worker (not the side panel) so it works
 * even when the side panel is closed — e.g. triggered from the in-page bot's
 * push-to-talk shortcut. Every tool is executed here: page ops go to the active
 * tab's content script, reminders/notifications through this worker, the profile
 * from local storage, research through the local crawler service.
 *
 * `fillForm` stages a plan (a `diggy:fill-plan` message to the page) instead of
 * filling, so the user confirms first. Nothing is ever submitted.
 */
import { toCoreMessages } from '@diggy/core';
import type { ToolContext } from '@diggy/core';
import {
  DEFAULT_CRAWL_DEPTH,
  DEFAULT_CRAWL_MAX_PAGES,
  type ChatMessage,
  type FillInstruction,
  type MethodParams,
  type MethodResults,
  type Profile,
  type Reminder,
} from '@diggy/shared';
import { makeId, type ContentMethod, type ContentMethodParams } from './messages';
import { addReminder, getProfile, getReminders, getSettings } from './storage';
import { extractRemote, fetchReadable, searchRemote } from './web';
import { readCalendarSmart, readInboxSmart } from './accounts';
import { appendChat, loadChat, MAX_CHAT_MESSAGES } from './chat-memory';
import { runResilient } from './brain';

/* ------------------------------------------------------------------ *
 * Tool context (background flavour)
 * ------------------------------------------------------------------ */

class BackgroundToolContext implements ToolContext {
  /** Whether the model asked us to speak (so the host doesn't double-speak). */
  spoke = false;

  constructor(private readonly tabId?: number) {}

  private async content<M extends ContentMethod>(
    method: M,
    params: ContentMethodParams[M],
  ): Promise<unknown> {
    if (this.tabId == null) throw new Error('No active tab to work with');
    const response = (await browser.tabs.sendMessage(this.tabId, {
      type: 'diggy:content-exec',
      method,
      params,
    })) as { ok?: boolean; result?: unknown; error?: string } | undefined;
    if (!response || response.ok === false) {
      throw new Error(response?.error ?? 'The page did not respond');
    }
    return response.result;
  }

  readPage = async (params: MethodParams['readPage']): Promise<MethodResults['readPage']> => {
    // A URL means "fetch it yourself" — never ask the user to open a tab.
    if (params.url && params.url.trim()) {
      const page = await extractRemote(params.url.trim());
      return { url: page.url, title: page.title, text: page.text };
    }
    return (await this.content('readPage', {
      includeFields: params.includeFields ?? true,
    })) as MethodResults['readPage'];
  };

  fillForm = async (params: MethodParams['fillForm']): Promise<MethodResults['fillForm']> => {
    if (params.submit) {
      throw new Error('Diggy never submits forms automatically. Ask the user to confirm.');
    }
    // Stage a plan for the page to confirm.
    if (this.tabId != null) {
      await browser.tabs
        .sendMessage(this.tabId, { type: 'diggy:fill-plan', fields: params.fields })
        .catch(() => undefined);
    }
    return { filled: 0, skipped: params.fields.map((field) => field.fieldId) };
  };

  getProfile = async (params: MethodParams['getProfile']): Promise<Partial<Profile>> => {
    const profile = await getProfile();
    if (!profile) return {};
    if (!params.section) return profile;
    return { [params.section]: profile[params.section] } as Partial<Profile>;
  };

  createReminder = async (params: MethodParams['createReminder']): Promise<Reminder> => {
    const reminder: Reminder = {
      id: makeId('rem'),
      title: params.title,
      notes: params.notes,
      dueAt: params.dueAt,
      status: 'pending',
      createdAt: new Date().toISOString(),
      source: 'voice',
    };
    await addReminder(reminder);
    try {
      await browser.runtime.sendMessage({ type: 'diggy:reminder-schedule', reminder });
    } catch {
      /* background is us — the reminder is persisted regardless */
    }
    const due = new Date(reminder.dueAt).getTime();
    if (Number.isFinite(due)) {
      browser.alarms.create(`diggy:reminder:${reminder.id}`, {
        when: Math.max(due, Date.now() + 1000),
      });
    }
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
      const payload = (await response.json()) as unknown;
      const list = Array.isArray(payload) ? payload : ((payload as { results?: unknown[] }).results ?? []);
      const pages = (list as { url?: string; title?: string; markdown?: string }[]).map((page) => ({
        url: page.url ?? '',
        title: page.title ?? '',
        markdown: page.markdown ?? '',
      }));
      if (pages.length > 0) return pages;
      throw new Error('empty crawl');
    } catch {
      // No crawler service: fetch the single page ourselves.
      const page = await fetchReadable(params.url);
      return [{ url: page.url, title: page.title, markdown: page.text }];
    }
  };

  searchWeb = async (params: MethodParams['searchWeb']): Promise<MethodResults['searchWeb']> =>
    searchRemote(params.query);

  readInbox = async (params: MethodParams['readInbox']): Promise<MethodResults['readInbox']> =>
    readInboxSmart({ query: params.query, max: params.max });

  readCalendar = async (
    params: MethodParams['readCalendar'],
  ): Promise<MethodResults['readCalendar']> =>
    readCalendarSmart({ days: params.days, max: params.max });

  notify = async (params: MethodParams['notify']): Promise<void> => {
    if (this.tabId != null) {
      await browser.tabs
        .sendMessage(this.tabId, { type: 'diggy:notify', title: params.title, body: params.body })
        .catch(() => undefined);
    }
    try {
      await browser.notifications.create({
        type: 'basic',
        title: params.title,
        message: params.body ?? 'Diggy',
      });
    } catch {
      /* best-effort */
    }
  };

  speak = async (params: MethodParams['speak']): Promise<void> => {
    this.spoke = true;
    await this.content('speak', { text: params.text }).catch(() => undefined);
  };

  setMood = async (params: MethodParams['setMood']): Promise<void> => {
    await this.content('setMood', { mood: params.mood }).catch(() => undefined);
  };

  playAnim = async (params: MethodParams['playAnim']): Promise<void> => {
    await this.content('playAnim', { state: params.state }).catch(() => undefined);
  };
}

/* ------------------------------------------------------------------ *
 * Conversation + run
 * ------------------------------------------------------------------ */

export interface AskOptions {
  tabId?: number;
  onDelta?: (chunk: string, full: string) => void;
}

export interface AskResult {
  text: string;
  spoke: boolean;
  ok: boolean;
  error?: string;
  provider?: string;
}

/**
 * Run one agent turn for a spoken/typed instruction.
 *
 * Uses the resilient runner (automatic Groq ⇄ NVIDIA failover on limits) and
 * the shared persistent chat memory, so voice and typed chat share context.
 */
export async function askDiggy(text: string, options: AskOptions = {}): Promise<AskResult> {
  const settings = await getSettings();
  const userMessage: ChatMessage = {
    id: makeId('msg'),
    role: 'user',
    content: text,
    createdAt: new Date().toISOString(),
  };

  const stored = await loadChat();
  const windowed = [...stored, userMessage].slice(-(MAX_CHAT_MESSAGES - 1));

  const result = await runResilient({
    settings,
    messages: toCoreMessages(windowed),
    makeContext: () => new BackgroundToolContext(options.tabId),
    onDelta: options.onDelta,
  });

  const spoke = Boolean((result.context as { spoke?: boolean }).spoke);
  const answer = result.text;
  await appendChat(userMessage, {
    id: makeId('msg'),
    role: 'assistant',
    content: answer,
    createdAt: new Date().toISOString(),
  });

  return { text: answer, spoke, ok: result.ok, error: result.error, provider: result.provider };
}

/** Apply a confirmed fill plan to a tab. */
export async function applyFillToTab(
  tabId: number | undefined,
  fields: FillInstruction[],
): Promise<MethodResults['fillForm']> {
  if (tabId == null) throw new Error('No active tab');
  const response = (await browser.tabs.sendMessage(tabId, {
    type: 'diggy:content-exec',
    method: 'fillForm',
    params: { fields },
  })) as { ok?: boolean; result?: MethodResults['fillForm'] } | undefined;
  return response?.result ?? { filled: 0, skipped: [] };
}
