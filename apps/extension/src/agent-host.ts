/**
 * Agent host — binds `@diggy/agent` to the extension service worker.
 *
 * The durable runtime (`packages/agent`) owns the run loop, the step budget, the
 * loop guard and the checkpointing; this module is the glue that gives it the
 * four things it deliberately does not depend on:
 *
 *   1. **storage** — a `chrome.storage.local` `CheckpointStorage`, persisted
 *      next to the chat history (`chat-memory.ts`) so a run the MV3 worker was
 *      killed in the middle of resumes in the *same* conversation.
 *   2. **step** — `runResilient` from `brain.ts`, so the existing Groq ⇄ NVIDIA
 *      provider failover is preserved verbatim: one runtime step is one agent
 *      turn.
 *   3. **sink** — an activity log mirrored to the side panel AND the active
 *      tab's bubble (reusing the messaging patterns in `messages.ts`).
 *   4. **token budgeting** — every tool result is passed through
 *      `capToolResult` before it can reach the model, and long histories are
 *      folded with `summarizeConversation`.
 *
 * Nothing here logs audio or secrets: the sink carries tool ids, counts, capped
 * text and short reasons only.
 */
import { createProvider, runAgentToText, toCoreMessages } from '@diggy/core';
import type { ToolContext } from '@diggy/core';
import {
  DEFAULT_CRAWL_DEPTH,
  DEFAULT_CRAWL_MAX_PAGES,
  type ChatMessage,
  type MethodParams,
  type MethodResults,
  type Reminder,
  type ToolName,
} from '@diggy/shared';
// NOTE: `@diggy/agent` is a workspace package that is not linked into
// `apps/extension/node_modules` (no `pnpm install` this round), so it is imported
// by path. Once `"@diggy/agent": "workspace:*"` is added to the extension's
// `package.json` this becomes `from '@diggy/agent'` — a one-line change.
import {
  AgentRuntime,
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  capToolResult,
  normalizeCheckpoint,
  summarizeConversation,
  type ActivityEvent,
  type ActivitySink,
  type AgentMessage,
  type BudgetOverrides,
  type CheckpointStorage,
  type PendingAction,
  type RunResult,
  type RunStatus,
  type StepFn,
  type StepInput,
  type StepResult,
  type SummarizeModel,
} from '../../../packages/agent/src/index';
import { makeId, type AgentActivityMessage, type AgentActivityView, type ContentMethod, type ContentMethodParams } from './messages';
import { runResilient, providerChain } from './brain';
import {
  appendChat,
  clearAgentCheckpoint,
  loadAgentCheckpoint,
  loadChat,
  saveAgentCheckpoint,
  MAX_CHAT_MESSAGES,
} from './chat-memory';
import {
  addReminder,
  getProfile as readStoredProfile,
  getReminders,
  getSettings,
  type Settings,
} from './storage';
import { extractRemote, fetchReadable, searchRemote } from './web';
import { readCalendarSmart, readInboxSmart } from './accounts';

type ModelMessages = Parameters<typeof runResilient>[0]['messages'];

/** Fold the history once it is longer than this many messages. */
const LONG_HISTORY_THRESHOLD = 30;
/** Messages kept verbatim by `summarizeConversation` when it folds. */
const KEEP_RECENT_MESSAGES = 10;
/** Cap on map/reduce chunks for one summarisation (garbage guard). */
const SUMMARY_MAX_CHUNKS = 8;

/** Terminal states that are worth resuming from a checkpoint. */
const RESUMABLE_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'budget-exceeded',
  'timeout',
  'awaiting-approval',
]);

export interface RunGoalOptions {
  /** Tab whose content script executes page tools. Resolved lazily if omitted. */
  tabId?: number;
  /** Explicit run id (defaults to a fresh `run-…`). */
  runId?: string;
  /** Streamed reply deltas (the panel/bubble render these). */
  onDelta?: (delta: string, full: string) => void;
  /** Step budget + wall-clock limit for this run. */
  budget?: BudgetOverrides;
  /** Identical actions before loop detection fires. */
  loopThreshold?: number;
  /** Force a resume of the latest checkpoint instead of starting fresh. */
  resume?: boolean;
}

export interface RunGoalOutcome {
  runId: string;
  status: RunStatus;
  /** The assistant reply (the last turn's text), or `''`. */
  text: string;
  ok: boolean;
  /** True when the model already spoke (so the host must not speak again). */
  spoke: boolean;
  result: RunResult;
}

/** The one run in flight for this worker, if any (used by `stopActiveRun`). */
let activeRuntime: AgentRuntime | null = null;

/* ------------------------------------------------------------------ *
 * Checkpoint storage (chrome.storage.local, next to the chat history)
 * ------------------------------------------------------------------ */

export function createCheckpointStorage(): CheckpointStorage {
  return {
    async save(checkpoint) {
      await saveAgentCheckpoint(checkpoint, false);
    },
    async load(runId) {
      const stored = await loadAgentCheckpoint();
      const checkpoint = stored ? normalizeCheckpoint(stored.checkpoint) : undefined;
      return checkpoint && checkpoint.runId === runId ? checkpoint : undefined;
    },
    async latest() {
      const stored = await loadAgentCheckpoint();
      return stored ? normalizeCheckpoint(stored.checkpoint) : undefined;
    },
    async clear(runId) {
      const stored = await loadAgentCheckpoint();
      const checkpoint = stored ? normalizeCheckpoint(stored.checkpoint) : undefined;
      if (!checkpoint || checkpoint.runId === runId) await clearAgentCheckpoint();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Activity sink (side panel + active tab's bubble)
 * ------------------------------------------------------------------ */

function toActivityView(event: ActivityEvent): AgentActivityView {
  const view: AgentActivityView = {
    kind: event.type,
    runId: event.runId,
    stepIndex: event.stepIndex,
    at: event.at,
  };
  switch (event.type) {
    case 'tool':
      view.tool = event.tool;
      view.args = event.args;
      break;
    case 'tool-result':
      view.tool = event.tool;
      // Already capped before it reaches a surface — never ship a whole page.
      view.text = capToolResult(event.text, 600);
      break;
    case 'awaiting-approval':
      view.tool = event.action.toolName;
      break;
    case 'error':
      view.message = event.message;
      break;
    case 'done':
      view.reason = event.reason;
      view.message = event.message;
      break;
    case 'step-started':
      break;
  }
  return view;
}

async function resolveActiveTabId(): Promise<number | undefined> {
  try {
    const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    return tabs[0]?.id;
  } catch {
    return undefined;
  }
}

/**
 * Mirror every runtime activity event to the side panel (a runtime broadcast)
 * AND the active tab's bubble (a tab message) — the two patterns already used
 * for `diggy:agent-delta` / `diggy:agent-done`.
 */
function createActivitySink(tabId: number | undefined, goal: string): ActivitySink {
  let cachedTabId = tabId;
  return {
    emit(event: ActivityEvent): void {
      const message: AgentActivityMessage = {
        type: 'diggy:agent-activity',
        activity: toActivityView(event),
        running: event.type !== 'done',
        goal,
      };
      // Side panel (and any other extension page listening).
      void browser.runtime.sendMessage(message).catch(() => undefined);
      // The in-page bubble, in the run's tab.
      void (async () => {
        if (cachedTabId == null) cachedTabId = await resolveActiveTabId();
        if (cachedTabId == null) return;
        await browser.tabs.sendMessage(cachedTabId, message).catch(() => undefined);
      })();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Token budgeting: cap every tool result before it reaches the model
 * ------------------------------------------------------------------ */

/**
 * Recurse through a tool result and run every string through `capToolResult`,
 * so a 90 kB page (or a 91 k-character transcript) can never blow the prompt.
 */
function capValue<T>(value: T, maxChars: number = DEFAULT_MAX_TOOL_RESULT_CHARS): T {
  if (typeof value === 'string') return capToolResult(value, maxChars) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => capValue(item, maxChars)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = capValue(item, maxChars);
    }
    return out as unknown as T;
  }
  return value;
}

function pageSignatureOf(args: unknown): string {
  if (args && typeof args === 'object' && 'url' in args) {
    const url = (args as { url?: unknown }).url;
    if (typeof url === 'string') return url;
  }
  return '';
}

/**
 * The background flavour of `@diggy/core`'s {@link ToolContext}.
 *
 * Same executors as the existing background brain (page ops via the tab's
 * content script, reminders/notifications through this worker, the profile from
 * local storage, research via the local crawler service), plus two additions
 * the runtime needs: it records the **last action** (for loop detection) and
 * caps **every** result through {@link capValue}.
 */
class HostToolContext implements ToolContext {
  /** Whether the model asked us to speak (so the host does not double-speak). */
  spoke = false;
  /** The most recent tool call — feeds the runtime's loop detector. */
  lastAction: PendingAction | null = null;

  constructor(private readonly tabId?: number) {}

  private record(toolName: ToolName, args: unknown): void {
    this.lastAction = { toolName, args, pageSignature: pageSignatureOf(args) };
  }

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
    this.record('readPage', params);
    if (params.url && params.url.trim()) {
      const page = await extractRemote(params.url.trim());
      return capValue({ url: page.url, title: page.title, text: page.text });
    }
    const page = (await this.content('readPage', {
      includeFields: params.includeFields ?? true,
    })) as MethodResults['readPage'];
    return capValue(page);
  };

  fillForm = async (params: MethodParams['fillForm']): Promise<MethodResults['fillForm']> => {
    this.record('fillForm', { count: params.fields?.length ?? 0, submit: params.submit === true });
    if (params.submit) {
      throw new Error('Diggy never submits forms automatically. Ask the user to confirm.');
    }
    if (this.tabId != null) {
      await browser.tabs
        .sendMessage(this.tabId, { type: 'diggy:fill-plan', fields: params.fields })
        .catch(() => undefined);
    }
    return { filled: 0, skipped: (params.fields ?? []).map((field) => field.fieldId) };
  };

  getProfile = async (params: MethodParams['getProfile']): Promise<MethodResults['getProfile']> => {
    const profile = await readStoredProfile();
    if (!profile) return {};
    if (!params.section) return capValue(profile);
    return capValue({ [params.section]: profile[params.section] } as MethodResults['getProfile']);
  };

  createReminder = async (params: MethodParams['createReminder']): Promise<Reminder> => {
    this.record('createReminder', { title: params.title, dueAt: params.dueAt });
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
      /* the background is us — the reminder is persisted regardless */
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
    this.record('listReminders', {});
    const reminders = await getReminders();
    return reminders
      .filter((reminder) => reminder.status !== 'done')
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt));
  };

  crawl = async (params: MethodParams['crawl']): Promise<MethodResults['crawl']> => {
    this.record('crawl', params);
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
      if (pages.length > 0) return capValue(pages);
      throw new Error('empty crawl');
    } catch {
      // No crawler service: fetch the single page ourselves.
      const page = await fetchReadable(params.url);
      return capValue([{ url: page.url, title: page.title, markdown: page.text }]);
    }
  };

  searchWeb = async (params: MethodParams['searchWeb']): Promise<MethodResults['searchWeb']> => {
    this.record('searchWeb', params);
    return capValue(await searchRemote(params.query));
  };

  readInbox = async (params: MethodParams['readInbox']): Promise<MethodResults['readInbox']> => {
    this.record('readInbox', { query: params.query, max: params.max });
    return capValue(await readInboxSmart({ query: params.query, max: params.max }));
  };

  readCalendar = async (
    params: MethodParams['readCalendar'],
  ): Promise<MethodResults['readCalendar']> => {
    this.record('readCalendar', { days: params.days, max: params.max });
    return capValue(await readCalendarSmart({ days: params.days, max: params.max }));
  };

  notify = async (params: MethodParams['notify']): Promise<void> => {
    this.record('notify', { title: params.title });
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
    this.record('speak', {});
    this.spoke = true;
    await this.content('speak', { text: params.text }).catch(() => undefined);
  };

  setMood = async (params: MethodParams['setMood']): Promise<void> => {
    this.record('setMood', { mood: params.mood });
    await this.content('setMood', { mood: params.mood }).catch(() => undefined);
  };

  playAnim = async (params: MethodParams['playAnim']): Promise<void> => {
    this.record('playAnim', { state: params.state });
    await this.content('playAnim', { state: params.state }).catch(() => undefined);
  };
}

/* ------------------------------------------------------------------ *
 * History → model messages (with token budgeting)
 * ------------------------------------------------------------------ */

/**
 * A `ToolContext` that is never used: it lets `runAgentToText` build a bare,
 * tool-less model for summarisation without a second dependency.
 */
const NO_TOOL_CONTEXT = new Proxy({}, {
  get: () => () => {
    throw new Error('Summarisation has no tools.');
  },
}) as unknown as ToolContext;

/**
 * The model `summarizeConversation` maps/reduces with — a plain tool-less
 * completion through the same providers (and `providerChain`) the brain uses.
 * No key or a failure yields `''` so a summary can never take the run down.
 */
function createSummarizer(settings: Settings): SummarizeModel {
  return async (request) => {
    const name = providerChain(settings)[0] ?? settings.provider;
    const apiKey = (name === 'groq' ? settings.groqKey : settings.nvidiaKey).trim();
    if (!apiKey) return '';
    try {
      const result = await runAgentToText({
        provider: createProvider({ name, apiKey, model: settings.model?.trim() || undefined }),
        systemPrompt:
          'You compress a conversation. Keep every fact, name, number and decision; drop pleasantries. Reply with the summary only.',
        messages: [
          {
            role: 'user',
            content: `Compress the following conversation excerpt into a terse summary:\n\n${request.text}`,
          },
        ],
        tools: {},
        context: NO_TOOL_CONTEXT,
        maxSteps: 1,
        abortSignal: request.signal,
      });
      return (result.text ?? '').trim();
    } catch {
      return '';
    }
  };
}

function toChatMessages(messages: AgentMessage[]): ChatMessage[] {
  const now = new Date().toISOString();
  return messages.map((message, index) => ({
    id: message.id ?? `sum-${index}`,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt ?? now,
  }));
}

async function buildModelMessages(
  history: ChatMessage[],
  settings: Settings,
  signal: AbortSignal,
): Promise<ModelMessages> {
  if (history.length <= LONG_HISTORY_THRESHOLD) return toCoreMessages(history);
  try {
    const folded = await summarizeConversation(history, {
      model: createSummarizer(settings),
      keepRecent: KEEP_RECENT_MESSAGES,
      maxChunks: SUMMARY_MAX_CHUNKS,
      signal,
    });
    return toCoreMessages(toChatMessages(folded.messages));
  } catch {
    // A summary is an optimisation; never let it lose the turn.
    return toCoreMessages(history);
  }
}

/* ------------------------------------------------------------------ *
 * The step function: one runtime step = one resilient agent turn
 * ------------------------------------------------------------------ */

interface StepBundle {
  step: StepFn;
  answer: () => string;
  spoke: () => boolean;
}

/**
 * Resolve with the promise's value, or `undefined` the moment `signal` aborts —
 * so a Stop settles the runtime at the next boundary instead of waiting out a
 * full streaming turn. A rejection is passed through (the runtime logs it).
 */
async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return undefined;
  let remove = (): void => {};
  const aborted = new Promise<undefined>((resolve) => {
    const onAbort = (): void => resolve(undefined);
    remove = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    remove();
  }
}

function createStep(options: RunGoalOptions, storage: CheckpointStorage): StepBundle {
  let answer = '';
  let spoke = false;
  const createdAt = new Date().toISOString();

  const step: StepFn = async (input: StepInput): Promise<StepResult> => {
    if (input.signal.aborted) {
      return { messagesSummary: input.messagesSummary, error: 'Run stopped.' };
    }

    const settings = await getSettings();
    const tabId = options.tabId ?? (await resolveActiveTabId());
    const context = new HostToolContext(tabId);

    // Rebuild the turn deterministically from the persisted history + the goal,
    // so a resumed run sees exactly the conversation the first attempt did.
    const history = await loadChat();
    const userMessage: ChatMessage = {
      id: makeId('msg'),
      role: 'user',
      content: input.goal,
      createdAt: new Date().toISOString(),
    };
    const windowed = [...history, userMessage].slice(-(MAX_CHAT_MESSAGES - 1));
    const messages = await buildModelMessages(windowed, settings, input.signal);

    // The existing Groq ⇄ NVIDIA failover, unchanged: this *is* the step.
    const result = await raceWithAbort(
      runResilient({
        settings,
        messages,
        makeContext: () => context,
        onDelta: (delta, full) => {
          if (!input.signal.aborted) options.onDelta?.(delta, full);
        },
      }),
      input.signal,
    );

    if (!result) {
      // Cancelled mid-stream: the runtime aborts and checkpoints this boundary.
      return { messagesSummary: input.messagesSummary, error: 'Run stopped.' };
    }

    answer = result.text;
    spoke = context.spoke;
    const stepResult: StepResult = {
      messagesSummary: capToolResult(`${input.goal}\n→ ${result.text}`, 800),
      pendingAction: context.lastAction,
      text: capToolResult(result.text, 8000),
      error: result.ok ? undefined : result.error ?? 'The model did not respond.',
      done: result.ok,
    };

    // "After every step persist it": the runtime writes a checkpoint at the
    // start and at the end of a run, so an *intermediate* step (a run that
    // continues) gets one from here — an MV3 kill between steps then resumes
    // from the next step instead of repeating this one.
    const intermediate =
      stepResult.error === undefined && stepResult.done !== true && stepResult.awaitingApproval !== true;
    if (intermediate) {
      await storage.save({
        runId: input.runId,
        goal: input.goal,
        stepIndex: input.stepIndex + 1,
        messagesSummary: stepResult.messagesSummary ?? input.messagesSummary,
        pendingAction: stepResult.pendingAction ?? null,
        createdAt,
      });
    }

    return stepResult;
  };

  return { step, answer: () => answer, spoke: () => spoke };
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Run (or resume) one goal through the durable runtime. Resolves when the run
 * settles — `done`, a budget/timeout park, a cancel, or an error.
 */
export async function runGoal(goal: string, options: RunGoalOptions = {}): Promise<RunGoalOutcome> {
  const runId = options.runId ?? makeId('run');
  const storage = createCheckpointStorage();
  const { step, answer, spoke } = createStep(options, storage);
  const runtime = new AgentRuntime({
    storage,
    step,
    sink: createActivitySink(options.tabId, goal),
    budget: options.budget,
    loopThreshold: options.loopThreshold,
    idFactory: () => runId,
  });

  activeRuntime = runtime;
  try {
    const stored = await loadAgentCheckpoint();
    const target = stored && !stored.finished ? normalizeCheckpoint(stored.checkpoint) : undefined;
    const shouldResume = options.resume === true || (target != null && target.goal === goal);

    const result = shouldResume ? await runtime.resume() : await runtime.run(goal, { runId });
    const text = answer();

    // Keep only what is worth resuming; everything else is settled.
    await settleCheckpoint(result.status);

    if (text.trim() && result.status !== 'cancelled') {
      await appendChat(
        { id: makeId('msg'), role: 'user', content: goal, createdAt: new Date().toISOString() },
        { id: makeId('msg'), role: 'assistant', content: text, createdAt: new Date().toISOString() },
      );
    }

    return { runId: result.runId, status: result.status, text, ok: result.status === 'done', spoke: spoke(), result };
  } finally {
    if (activeRuntime === runtime) activeRuntime = null;
  }
}

/** Resume the newest unfinished run, if one survived a worker death. */
export async function resumeUnfinishedRun(): Promise<RunGoalOutcome | undefined> {
  const stored = await loadAgentCheckpoint();
  const target = stored && !stored.finished ? normalizeCheckpoint(stored.checkpoint) : undefined;
  if (!target) return undefined;
  return runGoal(target.goal, { resume: true });
}

/** Is there a checkpoint a resume would actually continue? */
export async function hasUnfinishedRun(): Promise<boolean> {
  const stored = await loadAgentCheckpoint();
  if (!stored || stored.finished) return false;
  return normalizeCheckpoint(stored.checkpoint) !== undefined;
}

/**
 * Abort the active run. The signal reaches the step immediately; the run
 * settles at the next boundary with a resumable checkpoint. Safe to call when
 * nothing is running (returns `false`).
 */
export function stopActiveRun(reason = 'Stopped by the user.'): boolean {
  if (!activeRuntime) return false;
  activeRuntime.cancel(reason);
  return true;
}

/** True while a run owns this worker. */
export function isRunActive(): boolean {
  return activeRuntime !== null;
}

/** Drop a parked checkpoint (used when a caller wants a clean slate). */
export async function abandonCheckpoint(): Promise<void> {
  await clearAgentCheckpoint();
}

async function settleCheckpoint(status: RunStatus): Promise<void> {
  if (RESUMABLE_STATUSES.has(status)) return;
  await clearAgentCheckpoint();
}
