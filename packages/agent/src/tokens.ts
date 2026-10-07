/**
 * Token budgeting.
 *
 * Three tools for keeping prompts inside a context window:
 *   - `capToolResult` — a hard, marker-annotated character cap for tool output;
 *   - `summarizeLongText` — a map-reduce contract with the model injected as a
 *     plain function (so it is testable with no network);
 *   - `summarizeConversation` — folds a long history down to a summary plus the
 *     most recent turns.
 *
 * The model is never imported — it is a function the caller supplies. Nothing
 * here throws on garbage input; only an explicit `AbortSignal` can stop a
 * summary, and it does so by rejecting with an `AbortError`.
 */
import { toNonNegativeInt, toPositiveInt } from './numbers';

/** Default cap on a single tool result, in characters. */
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 4000;
/** Characters reserved for the truncation marker so the cap is a real cap. */
export const TRUNCATION_MARKER_RESERVE = 48;
/** Default characters per map/reduce chunk. */
export const DEFAULT_SUMMARY_CHUNK_CHARS = 6000;
/** Default ceiling on chunks read from one document (garbage guard). */
export const DEFAULT_SUMMARY_MAX_CHUNKS = 40;
/** Default reduce rounds before we stop merging (garbage guard). */
export const DEFAULT_SUMMARY_MAX_ROUNDS = 3;
/** Default recent-turn tail kept verbatim by `summarizeConversation`. */
export const DEFAULT_KEEP_RECENT = 6;
/** Prefix on the synthetic message that carries a folded history. */
export const CONVERSATION_SUMMARY_PREFIX = '[Earlier conversation summary]';

/**
 * Cap tool output, documented policy:
 *   - non-string input is coerced (`null`/`undefined` → `''`), never throws;
 *   - text at or under the cap is returned **unchanged** (no marker);
 *   - longer text keeps its head and gains a `\n…[truncated N more characters]`
 *     marker, and the result length never exceeds `maxChars` (a reserve of
 *     {@link TRUNCATION_MARKER_RESERVE} characters is held back for the marker);
 *   - a cap of `0` yields `''`; a non-finite or negative cap falls back to
 *     {@link DEFAULT_MAX_TOOL_RESULT_CHARS}.
 */
export function capToolResult(text: unknown, maxChars: number = DEFAULT_MAX_TOOL_RESULT_CHARS): string {
  const value = typeof text === 'string' ? text : text === null || text === undefined ? '' : String(text);
  const cap =
    typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars >= 0
      ? Math.floor(maxChars)
      : DEFAULT_MAX_TOOL_RESULT_CHARS;
  if (cap === 0) return '';
  if (value.length <= cap) return value;
  const headLength = Math.max(0, cap - TRUNCATION_MARKER_RESERVE);
  const head = value.slice(0, headLength);
  const marker = `\n…[truncated ${value.length - head.length} more characters]`;
  const capped = head + marker;
  return capped.length <= cap ? capped : capped.slice(0, cap);
}

/**
 * Slice text into chunks of at most `chunkChars`, preferring to break at a
 * newline or space in the final 40% of each chunk. Always makes progress, so it
 * cannot loop.
 */
export function chunkText(text: string, chunkChars: number = DEFAULT_SUMMARY_CHUNK_CHARS): string[] {
  const value = typeof text === 'string' ? text : '';
  const size = toPositiveInt(chunkChars, DEFAULT_SUMMARY_CHUNK_CHARS);
  const chunks: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(value.length, start + size);
    if (end < value.length) {
      const windowStart = start + Math.floor(size * 0.6);
      const window = value.slice(windowStart, end);
      const br = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
      if (br >= 0) end = windowStart + br + 1;
    }
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}

/** One map or reduce request handed to the injected model. */
export interface SummarizeRequest {
  kind: 'map' | 'reduce';
  text: string;
  index: number;
  total: number;
  signal?: AbortSignal;
}

/** The model, injected as a function. */
export type SummarizeModel = (request: SummarizeRequest) => string | Promise<string>;

export interface SummarizeLongTextOptions {
  model: SummarizeModel;
  chunkChars?: number;
  maxChunks?: number;
  maxRounds?: number;
  signal?: AbortSignal;
}

export interface SummarizeResult {
  summary: string;
  /** Number of map chunks actually summarised. */
  chunks: number;
  /** Number of reduce rounds performed. */
  rounds: number;
  /** True when the input was longer than `chunkChars * maxChunks`. */
  truncated: boolean;
  /** False when the model was never called (empty input or no model given). */
  viaModel: boolean;
}

/**
 * Map-reduce a long document down to one summary.
 *
 * Contract:
 *   - **map** — every chunk yields a partial summary;
 *   - **reduce** — partials are re-joined and re-chunked, each piece reducing
 *     the set, repeated at most `maxRounds` times until one partial remains;
 *   - empty/garbage input returns `{ summary: '' }` **without** calling the
 *     model;
 *   - a missing/non-function model echoes the (uncapped) text back;
 *   - a model that throws yields an empty partial for that piece rather than
 *     failing the whole summary — unless it throws `AbortError`.
 */
export async function summarizeLongText(
  raw: unknown,
  options: SummarizeLongTextOptions,
): Promise<SummarizeResult> {
  const text = typeof raw === 'string' ? raw : raw === null || raw === undefined ? '' : String(raw);
  const empty: SummarizeResult = { summary: '', chunks: 0, rounds: 0, truncated: false, viaModel: false };
  if (!text.trim()) return empty;

  const model = options?.model;
  if (typeof model !== 'function') {
    return { summary: text, chunks: 0, rounds: 0, truncated: false, viaModel: false };
  }

  const chunkChars = toPositiveInt(options?.chunkChars, DEFAULT_SUMMARY_CHUNK_CHARS);
  const maxChunks = toPositiveInt(options?.maxChunks, DEFAULT_SUMMARY_MAX_CHUNKS);
  const maxRounds = toNonNegativeInt(options?.maxRounds, DEFAULT_SUMMARY_MAX_ROUNDS);
  const signal = options?.signal;

  throwIfAborted(signal);

  const all = chunkText(text, chunkChars);
  const truncated = all.length > maxChunks;
  const chunks = truncated ? all.slice(0, maxChunks) : all;

  let partials: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    throwIfAborted(signal);
    partials.push(await callModel(model, { kind: 'map', text: chunks[index] ?? '', index, total: chunks.length, signal }));
  }

  let rounds = 0;
  while (partials.length > 1 && rounds < maxRounds) {
    throwIfAborted(signal);
    const groups = chunkText(partials.join('\n\n'), chunkChars);
    const next: string[] = [];
    for (let index = 0; index < groups.length; index += 1) {
      throwIfAborted(signal);
      next.push(await callModel(model, { kind: 'reduce', text: groups[index] ?? '', index, total: groups.length, signal }));
    }
    if (next.length === 0) break;
    partials = next;
    rounds += 1;
  }

  const summary = partials.length > 1 ? partials.join('\n\n') : partials[0] ?? '';
  return { summary, chunks: chunks.length, rounds, truncated, viaModel: true };
}

/** Structural shape compatible with `@diggy/shared`'s `ChatMessage`. */
export type AgentRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AgentMessage {
  id?: string;
  role: AgentRole;
  content: string;
  createdAt?: string;
  toolName?: string;
}

export interface SummarizeConversationOptions extends SummarizeLongTextOptions {
  /** How many trailing messages to keep verbatim. Default 6. */
  keepRecent?: number;
  /** Timestamp source for the synthetic summary message. */
  now?: () => string;
  /** Id source for the synthetic summary message. */
  newId?: () => string;
}

export interface SummarizeConversationResult {
  /** The compacted history: `[summaryMessage, ...recent]`, or a copy if short. */
  messages: AgentMessage[];
  summarized: boolean;
  /** How many older messages were folded into the summary. */
  dropped: number;
  summary: string;
  truncated: boolean;
}

/**
 * Fold a long history into a synthetic `system` summary plus the recent tail.
 * Short histories (<= `keepRecent`) are returned as a copy and the model is
 * never called.
 */
export async function summarizeConversation(
  raw: unknown,
  options: SummarizeConversationOptions,
): Promise<SummarizeConversationResult> {
  const all: AgentMessage[] = Array.isArray(raw) ? (raw as AgentMessage[]) : [];
  const keepRecent = toNonNegativeInt(options?.keepRecent, DEFAULT_KEEP_RECENT);

  if (all.length <= keepRecent) {
    return { messages: all.map(copyMessage), summarized: false, dropped: 0, summary: '', truncated: false };
  }

  const dropped = all.length - keepRecent;
  const older = all.slice(0, dropped);
  const recent = all.slice(dropped);
  const rendered = older.map(renderMessage).join('\n');

  const result = await summarizeLongText(rendered, options);
  const summaryMessage: AgentMessage = {
    id: typeof options?.newId === 'function' ? options.newId() : defaultMessageId(),
    role: 'system',
    content: `${CONVERSATION_SUMMARY_PREFIX}\n${result.summary}`,
    createdAt: typeof options?.now === 'function' ? options.now() : new Date().toISOString(),
  };

  return {
    messages: [summaryMessage, ...recent.map(copyMessage)],
    summarized: true,
    dropped,
    summary: result.summary,
    truncated: result.truncated,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function callModel(model: SummarizeModel, request: SummarizeRequest): Promise<string> {
  try {
    const out = await model(request);
    if (typeof out === 'string') return out;
    return out === null || out === undefined ? '' : String(out);
  } catch (error) {
    if (isAbortError(error)) throw error;
    // A local model hiccup must not sink the whole summary.
    return '';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal && signal.aborted) {
    const error = new Error('Summarisation aborted.');
    error.name = 'AbortError';
    throw error;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function normalizeRole(role: unknown): AgentRole {
  return role === 'system' || role === 'assistant' || role === 'tool' ? role : 'user';
}

function coerceContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return String(value);
  } catch {
    return '';
  }
}

function copyMessage(message: AgentMessage): AgentMessage {
  const source = (message ?? {}) as Partial<AgentMessage>;
  const out: AgentMessage = { role: normalizeRole(source.role), content: coerceContent(source.content) };
  if (typeof source.id === 'string') out.id = source.id;
  if (typeof source.createdAt === 'string') out.createdAt = source.createdAt;
  if (typeof source.toolName === 'string') out.toolName = source.toolName;
  return out;
}

function renderMessage(message: AgentMessage): string {
  const source = (message ?? {}) as Partial<AgentMessage>;
  const role = normalizeRole(source.role);
  const label = typeof source.toolName === 'string' && source.toolName ? `${role} (${source.toolName})` : role;
  return `${label}: ${coerceContent(source.content)}`;
}

function defaultMessageId(): string {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
