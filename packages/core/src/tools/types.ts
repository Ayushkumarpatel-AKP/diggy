/**
 * Platform-agnostic tool execution surface.
 *
 * The host (desktop companion / extension) injects a `ToolContext` whose
 * methods actually perform the work — reading the page, filling a form, reading
 * the vault profile, scheduling reminders, crawling, etc. `@diggy/core` only
 * *describes* the tools to the model and dispatches to these executors, which is
 * what keeps the brain platform-agnostic and trivially testable (inject a mock).
 *
 * The parameter/result shapes come from `@diggy/shared` so the bridge protocol
 * and the LLM tool schemas can never drift apart.
 */
import type { MethodParams, MethodResults, ToolName } from '@diggy/shared';

/** Executor for a single tool, keyed by tool name. */
export type ToolExecutor<K extends ToolName> = (
  params: MethodParams[K],
) => Promise<MethodResults[K]> | MethodResults[K];

export interface ToolContext {
  readPage: (params: MethodParams['readPage']) => Promise<MethodResults['readPage']> | MethodResults['readPage'];
  fillForm: (params: MethodParams['fillForm']) => Promise<MethodResults['fillForm']> | MethodResults['fillForm'];
  getProfile: (params: MethodParams['getProfile']) => Promise<MethodResults['getProfile']> | MethodResults['getProfile'];
  createReminder: (params: MethodParams['createReminder']) => Promise<MethodResults['createReminder']> | MethodResults['createReminder'];
  listReminders: (params: MethodParams['listReminders']) => Promise<MethodResults['listReminders']> | MethodResults['listReminders'];
  crawl: (params: MethodParams['crawl']) => Promise<MethodResults['crawl']> | MethodResults['crawl'];
  searchWeb: (params: MethodParams['searchWeb']) => Promise<MethodResults['searchWeb']> | MethodResults['searchWeb'];
  readInbox: (params: MethodParams['readInbox']) => Promise<MethodResults['readInbox']> | MethodResults['readInbox'];
  readCalendar: (params: MethodParams['readCalendar']) => Promise<MethodResults['readCalendar']> | MethodResults['readCalendar'];
  notify: (params: MethodParams['notify']) => Promise<MethodResults['notify']> | MethodResults['notify'];
  speak: (params: MethodParams['speak']) => Promise<MethodResults['speak']> | MethodResults['speak'];
  setMood: (params: MethodParams['setMood']) => Promise<MethodResults['setMood']> | MethodResults['setMood'];
  playAnim: (params: MethodParams['playAnim']) => Promise<MethodResults['playAnim']> | MethodResults['playAnim'];
}

/** Every tool name that must be present in the toolset. */
export const TOOL_NAMES: readonly ToolName[] = [
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
] as const;

export type { MethodParams, MethodResults, ToolName };
