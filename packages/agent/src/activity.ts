/**
 * The typed activity log.
 *
 * Every meaningful thing the run loop does is reported through an injected
 * `ActivitySink` — never a global, never `console`. The host wires this to
 * `chrome.storage`, the side panel, or a dev logger.
 */
import type { PendingAction, RunStatus } from './types';

export type ActivityEventType =
  | 'step-started'
  | 'tool'
  | 'tool-result'
  | 'awaiting-approval'
  | 'error'
  | 'done';

export interface StepStartedEvent {
  type: 'step-started';
  runId: string;
  stepIndex: number;
  at: string;
}

export interface ToolEvent {
  type: 'tool';
  runId: string;
  stepIndex: number;
  tool: string;
  args?: unknown;
  at: string;
}

export interface ToolResultEvent {
  type: 'tool-result';
  runId: string;
  stepIndex: number;
  tool: string;
  text: string;
  at: string;
}

export interface AwaitingApprovalEvent {
  type: 'awaiting-approval';
  runId: string;
  stepIndex: number;
  action: PendingAction;
  at: string;
}

export interface ErrorEvent {
  type: 'error';
  runId: string;
  stepIndex: number;
  message: string;
  at: string;
}

export interface DoneEvent {
  type: 'done';
  runId: string;
  stepIndex: number;
  reason: RunStatus;
  message: string;
  at: string;
}

export type ActivityEvent =
  | StepStartedEvent
  | ToolEvent
  | ToolResultEvent
  | AwaitingApprovalEvent
  | ErrorEvent
  | DoneEvent;

/** The injection point for the activity log. */
export interface ActivitySink {
  emit(event: ActivityEvent): void;
}

export type MemorySink = ActivitySink & { events: ActivityEvent[] };

/** A sink that keeps events in memory — handy for tests and for a dev panel. */
export function createMemorySink(): MemorySink {
  const events: ActivityEvent[] = [];
  return {
    events,
    emit(event: ActivityEvent): void {
      events.push(event);
    },
  };
}
