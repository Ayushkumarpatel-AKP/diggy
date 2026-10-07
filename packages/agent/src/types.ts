/**
 * Shared vocabulary for the durable agent runtime.
 *
 * The names here deliberately mirror the two systems this package replaces the
 * gaps in:
 *   - `packages/core/src/orchestrator.ts` (`step`, `maxSteps`, `abortSignal`,
 *     `messages`, `onStepFinish`) — so a `step()` can wrap `runAgent`.
 *   - `apps/extension/src/brain.ts` (`provider`, provider failover vocabulary) —
 *     so the router speaks the same language as the failover runner.
 */

/** The two interchangeable OpenAI-compatible brains, matching `brain.ts`. */
export type ProviderName = 'groq' | 'nvidia';

/**
 * One tool call the model decided on but that has not necessarily finished.
 * Loop detection watches `toolName + args + pageSignature`.
 */
export interface PendingAction {
  /** Tool id, e.g. `readPage` (see `@diggy/shared` `ToolName`). */
  toolName: string;
  /** Raw tool arguments — treated as opaque, never trusted. */
  args: unknown;
  /** A signature of the page the action ran against (usually its URL). */
  pageSignature: string;
}

/**
 * The durable unit of progress.
 *
 * Written after every completed step. `stepIndex` is both the number of
 * completed steps and the index of the **next** step to run — that is what
 * makes `resume()` able to skip work a dead service worker already finished.
 */
export interface Checkpoint {
  runId: string;
  goal: string;
  stepIndex: number;
  messagesSummary: string;
  pendingAction: PendingAction | null;
  createdAt: string;
}

/** Injected persistence. A `chrome.storage.session` or IndexedDB adapter fits here. */
export interface CheckpointStorage {
  save(checkpoint: Checkpoint): void | Promise<void>;
  load(runId: string): Checkpoint | undefined | Promise<Checkpoint | undefined>;
  /** The most recent checkpoint, whatever the run — used by `resume()`. */
  latest(): Checkpoint | undefined | Promise<Checkpoint | undefined>;
  clear(runId: string): void | Promise<void>;
}

/** Everything a `step()` needs to run one agent turn. */
export interface StepInput {
  runId: string;
  goal: string;
  /** Index of the step about to run (also the count of completed steps). */
  stepIndex: number;
  /** A growth-bounded summary of the conversation so far. */
  messagesSummary: string;
  /** The action carried over from the previous step, if any. */
  pendingAction: PendingAction | null;
  /** Aborted by `cancel()`, the budget or the wall-clock limit. Honoured end to end. */
  signal: AbortSignal;
}

/**
 * What a `step()` reports back. Every field is optional and defensively
 * normalised, so a step returning partial or garbage data can never crash the
 * loop.
 */
export interface StepResult {
  /** Updated conversation summary; becomes the next checkpoint's `messagesSummary`. */
  messagesSummary?: string;
  /** A tool call the model chose — the thing loop detection keys off. */
  pendingAction?: PendingAction | null;
  /** Tool output text, for the `tool-result` activity event. */
  text?: string;
  /** Non-empty when the step failed; the run ends with status `error`. */
  error?: string;
  /** The goal is complete. */
  done?: boolean;
  /** Pause and wait for a human to approve `pendingAction`. */
  awaitingApproval?: boolean;
}

/** The injected run-loop body: one agent turn per call. */
export type StepFn = (input: StepInput) => StepResult | Promise<StepResult>;

/** Terminal states of a run. */
export type RunStatus =
  | 'done'
  | 'cancelled'
  | 'budget-exceeded'
  | 'timeout'
  | 'loop-detected'
  | 'error'
  | 'awaiting-approval'
  | 'no-checkpoint';

/** What `run()` / `resume()` resolve to. */
export interface RunResult {
  runId: string;
  goal: string;
  status: RunStatus;
  /** Index of the next step to run; equals the number of completed steps. */
  stepIndex: number;
  /** Steps actually executed in this session (this worker wake). */
  steps: number;
  /** A short, human-readable reason — safe to show in the bubble. */
  message: string;
  /** A copy of the latest checkpoint (mutating it does not touch the runtime). */
  checkpoint: Checkpoint;
}
