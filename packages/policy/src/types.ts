/**
 * Vocabulary for the Diggy agent security policy layer.
 *
 * The policy layer sits *between* the model and the tool executors: before any
 * `ToolContext` method runs, {@link decide} is asked whether the call may
 * proceed. Everything here is plain data — no DOM, no `chrome`, no third-party
 * imports — so it runs identically in the extension service worker, the Tauri
 * desktop brain, and Node tests.
 */

/**
 * The only three classes a tool can belong to.
 *
 * - `read` — pulls data *in* (page, vault, inbox, search). No outward effect.
 * - `write` — local, reversible side effects (fill without submit, reminders,
 *   notifications, avatar/speech). An outward *effect*, but recoverable.
 * - `irreversible` — cannot be undone once it leaves (send, submit, delete,
 *   purchase, pay). Always gated.
 */
export type ToolCategory = 'read' | 'write' | 'irreversible';

/** A tool's class, or `unknown` for anything not in the registry. */
export type ToolClass = ToolCategory | 'unknown';

/** The three-valued outcome of a policy decision. */
export type Decision = 'allow' | 'confirm' | 'deny';

/**
 * Where the content that triggered a call came from.
 *
 * `untrusted` and `plugin` origins are treated as tainting (they carry
 * third-party text); `user`, `assistant`, `system` and `trusted` are not.
 */
export type ContentOrigin =
  | 'user'
  | 'assistant'
  | 'system'
  | 'trusted'
  | 'untrusted'
  | 'plugin'
  | 'unknown';

/** One recorded piece of untrusted content. */
export interface TaintSource {
  /** A short human label for where the content came from. */
  source: string;
  /** Length of the content (never the content itself — taint is not a store). */
  length: number;
  /** `Date.now()` when it was marked. */
  at: number;
}

/** The current taint state of the session. */
export interface TaintState {
  tainted: boolean;
  sources: readonly TaintSource[];
  lastUpdated: number | null;
}

/**
 * The payload a host shows the user before running a gated action.
 *
 * `preview` is already run through {@link redactForModel}, so vault values can
 * never leak into a confirmation UI that echoes a model message.
 */
export interface ConfirmPayload {
  tool: string;
  category: ToolClass;
  title: string;
  detail: string;
  reasons: readonly string[];
  site: string | null;
  preview: string;
}

/**
 * Everything {@link decide} needs beyond the tool and its arguments.
 *
 * All fields are optional so a caller can pass `{}` (most conservative:
 * taint is then read from the module store).
 */
export interface PolicyContext {
  /** Origin of the content that triggered the call. */
  origin?: ContentOrigin;
  /** Explicit taint override; when omitted the module taint store is consulted. */
  taint?: boolean | TaintState;
  /** Per-site allow list (hosts or URLs) the user has approved. */
  siteAllowlist?: readonly string[];
  /** URL the call targets / the page it acts on (checked against the blocklist). */
  url?: string;
}

/** The result of {@link decide}. */
export interface DecideResult {
  decision: Decision;
  /** Always present, human-readable, safe to log. */
  reason: string;
  /** The resolved tool class (`unknown` when the tool is not in the registry). */
  category: ToolClass;
  /** Present only when `decision === 'confirm'`. */
  confirmPayload?: ConfirmPayload;
}

/**
 * Every tool name the policy layer knows how to classify.
 *
 * The first group is the real registry from `@diggy/core`
 * (`buildToolset`/`TOOL_NAMES`). The rest is the vocabulary the crawler and the
 * plugin gateway use or will use; naming them here means they are *classified*,
 * not silently treated as unknown.
 */
export type PolicyToolName =
  // --- @diggy/core registry (13 real tools) ---
  | 'readPage'
  | 'fillForm'
  | 'getProfile'
  | 'createReminder'
  | 'listReminders'
  | 'crawl'
  | 'searchWeb'
  | 'readInbox'
  | 'readCalendar'
  | 'notify'
  | 'speak'
  | 'setMood'
  | 'playAnim'
  // --- crawler-read vocabulary ---
  | 'readTranscript'
  | 'readThread'
  | 'readDocument'
  // --- plugin gateway ---
  | 'pluginRead'
  | 'pluginWrite'
  // --- irreversible verbs ---
  | 'send'
  | 'sendEmail'
  | 'sendMessage'
  | 'submit'
  | 'submitForm'
  | 'delete'
  | 'purchase'
  | 'pay'
  | 'transfer'
  | 'post'
  | 'comment';
