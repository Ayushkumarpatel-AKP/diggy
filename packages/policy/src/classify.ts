/**
 * Tool classification.
 *
 * Every tool the agent can call is mapped to `read | write | irreversible`.
 * There is deliberately **no default**: a name that is not in
 * {@link TOOL_CLASSIFICATION} classifies as `unknown`, and `unknown` is denied
 * by {@link decide}. Adding a tool to the registry without classifying it here
 * fails safe (denied), never open.
 */
import type { PolicyToolName, ToolCategory, ToolClass } from './types';

/**
 * The 13 tools actually registered by `@diggy/core`'s `buildToolset()` and
 * listed in `TOOL_NAMES`. Kept here so a drift test can prove every real tool is
 * classified — this package has no dependency on `@diggy/core`.
 */
export const CORE_TOOL_NAMES = [
  'readPage',
  'fillForm',
  'getProfile',
  'createReminder',
  'listReminders',
  'crawl',
  'searchWeb',
  'readInbox',
  'readCalendar',
  'notify',
  'speak',
  'setMood',
  'playAnim',
] as const satisfies readonly PolicyToolName[];

/**
 * The classification table. Exhaustive over {@link PolicyToolName}: the
 * `Record` type means a new name added to the union without a class is a
 * compile error.
 */
export const TOOL_CLASSIFICATION: Readonly<Record<PolicyToolName, ToolCategory>> = {
  // --- reads: data comes in, nothing goes out ---
  readPage: 'read',
  getProfile: 'read',
  listReminders: 'read',
  crawl: 'read',
  searchWeb: 'read',
  readInbox: 'read',
  readCalendar: 'read',
  readTranscript: 'read',
  readThread: 'read',
  readDocument: 'read',
  pluginRead: 'read',

  // --- writes: local, reversible side effects ---
  fillForm: 'write',
  createReminder: 'write',
  notify: 'write',
  speak: 'write',
  setMood: 'write',
  playAnim: 'write',
  pluginWrite: 'write',

  // --- irreversible: cannot be undone once it leaves ---
  send: 'irreversible',
  sendEmail: 'irreversible',
  sendMessage: 'irreversible',
  submit: 'irreversible',
  submitForm: 'irreversible',
  delete: 'irreversible',
  purchase: 'irreversible',
  pay: 'irreversible',
  transfer: 'irreversible',
  post: 'irreversible',
  comment: 'irreversible',
};

/** Compile-time proof that every core tool name is covered by the union. */
type CoreCovered = (typeof CORE_TOOL_NAMES)[number] extends PolicyToolName ? true : never;
// `satisfies` above is the real guard; this alias documents the intent.
const _coreCovered: CoreCovered = true;
void _coreCovered;

/** Coerce anything into a trimmed tool name (never throws). */
export function normalizeToolName(tool: unknown): string {
  if (typeof tool === 'string') return tool.trim();
  if (typeof tool === 'number' || typeof tool === 'boolean' || typeof tool === 'bigint') {
    return String(tool);
  }
  return '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when the args ask fill/submit to actually submit. */
function hasSubmitFlag(args: unknown): boolean {
  if (!isPlainObject(args)) return false;
  return args['submit'] === true || args['submitForm'] === true || args['confirmSubmit'] === true;
}

/**
 * Classify a tool call. `fillForm` (and `submitForm`) upgrade to `irreversible`
 * when the arguments carry `submit: true`, because that is the moment a form
 * stops being reversible.
 */
export function classifyTool(tool: unknown, args?: unknown): ToolClass {
  const name = normalizeToolName(tool);
  if (name === '') return 'unknown';

  const base = (TOOL_CLASSIFICATION as Record<string, ToolCategory>)[name];
  if (base === undefined) return 'unknown';

  if ((name === 'fillForm' || name === 'submitForm') && hasSubmitFlag(args)) {
    return 'irreversible';
  }
  return base;
}

/** Is this a tool the policy layer knows about? */
export function isKnownTool(tool: unknown): boolean {
  return classifyTool(tool) !== 'unknown';
}

/**
 * Does running this class of tool have an outward effect (i.e. is it something
 * taint should force a confirmation for)? `unknown` is treated as outward too,
 * so a caller that forgets to check the class still fails safe.
 */
export function isOutwardEffect(category: ToolClass): boolean {
  return category !== 'read';
}
