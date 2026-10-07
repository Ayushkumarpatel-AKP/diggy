/**
 * The durable agent runtime.
 *
 * `AgentRuntime` owns one run loop. The loop body is injected (`step`), the
 * persistence is injected (`storage`), the log is injected (`sink`), and the
 * clock is injected (`clock`) — so the whole thing runs with no chrome and no
 * network, and a service-worker death is just "construct a new runtime and call
 * `resume()`".
 *
 * Guarantees:
 *   - every completed step is checkpointed *before* the next one starts, so
 *     `resume()` never repeats a completed step;
 *   - one `AbortSignal` flows from `cancel()` (and the budget) all the way into
 *     `step()`;
 *   - `cancel()` is idempotent;
 *   - a step budget, a wall-clock limit and loop detection always leave a
 *     resumable checkpoint;
 *   - garbage in never throws out.
 */
import type { ActivityEvent, ActivitySink } from './activity';
import { resolveBudget, type BudgetOverrides } from './budget';
import { actionSignature, LoopDetector, loopExplanation, DEFAULT_LOOP_THRESHOLD } from './loop';
import { toPositiveInt } from './numbers';
import { createMemoryCheckpointStorage } from './storage';
import type {
  Checkpoint,
  CheckpointStorage,
  PendingAction,
  RunResult,
  RunStatus,
  StepFn,
  StepInput,
  StepResult,
} from './types';

export interface RuntimeOptions {
  /** Durable checkpoint storage. Falls back to an in-memory store. */
  storage: CheckpointStorage;
  /** The loop body: run one agent turn and report what happened. */
  step: StepFn;
  /** Where the typed activity log goes. */
  sink?: ActivitySink;
  /** Step budget + wall-clock limit. Defaults: 20 steps, 2 minutes. */
  budget?: BudgetOverrides;
  /** Injectable clock (ms since epoch). Defaults to `Date.now`. */
  clock?: () => number;
  /** Identical actions before loop detection fires. Default 3. */
  loopThreshold?: number;
  /** Run-id generator. Defaults to a random `run_…`. */
  idFactory?: () => string;
}

export class AgentRuntime {
  private readonly storage: CheckpointStorage;
  private readonly step: StepFn;
  private readonly sink: ActivitySink | undefined;
  private readonly maxSteps: number;
  private readonly wallClockMs: number;
  private readonly clock: () => number;
  private readonly loopThreshold: number;
  private readonly idFactory: () => string;

  private controller = new AbortController();
  private cancelReason = 'Cancelled.';
  private current: Checkpoint | undefined;

  constructor(options: RuntimeOptions) {
    const source = (options ?? {}) as RuntimeOptions;
    this.storage = isStorage(source.storage) ? source.storage : createMemoryCheckpointStorage();
    this.step = typeof source.step === 'function' ? source.step : async () => ({ done: true });
    this.sink = source.sink;
    const budget = resolveBudget(source.budget);
    this.maxSteps = budget.maxSteps;
    this.wallClockMs = budget.wallClockMs;
    this.clock = typeof source.clock === 'function' ? source.clock : () => Date.now();
    this.loopThreshold = toPositiveInt(source.loopThreshold, DEFAULT_LOOP_THRESHOLD);
    this.idFactory = typeof source.idFactory === 'function' ? source.idFactory : defaultRunId;
  }

  /** The signal handed to `step()` — aborted by `cancel()`. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** The latest checkpoint, or `undefined` before the first run. */
  get checkpoint(): Checkpoint | undefined {
    return this.current ? cloneCheckpoint(this.current) : undefined;
  }

  /**
   * Start a fresh run. Writes the first checkpoint, then drives the loop until
   * it stops for any reason.
   */
  async run(goal: string, options: { runId?: string } = {}): Promise<RunResult> {
    this.controller = new AbortController();
    const runId =
      typeof options?.runId === 'string' && options.runId.length > 0 ? options.runId : this.idFactory();
    const start: Checkpoint = {
      runId,
      goal: coerceText(goal),
      stepIndex: 0,
      messagesSummary: '',
      pendingAction: null,
      createdAt: this.iso(),
    };
    this.current = start;
    await this.writeCheckpoint(start);
    return this.execute(start);
  }

  /**
   * Continue the most recent run after a worker wake. Rebuilds from the last
   * checkpoint and starts at `checkpoint.stepIndex`, so completed steps are
   * never repeated.
   */
  async resume(): Promise<RunResult> {
    this.controller = new AbortController();
    let found: unknown;
    try {
      found = await this.storage.latest();
    } catch {
      found = undefined;
    }
    const checkpoint = normalizeCheckpoint(found);
    if (!checkpoint) {
      const message = 'Nothing to resume — no checkpoint was found.';
      this.emit({ type: 'done', runId: '', stepIndex: 0, reason: 'no-checkpoint', message, at: this.iso() });
      return {
        runId: '',
        goal: '',
        status: 'no-checkpoint',
        stepIndex: 0,
        steps: 0,
        message,
        checkpoint: {
          runId: '',
          goal: '',
          stepIndex: 0,
          messagesSummary: '',
          pendingAction: null,
          createdAt: this.iso(),
        },
      };
    }
    return this.execute(checkpoint);
  }

  /**
   * Abort the run. The signal reaches `step()` immediately; the loop settles at
   * the next boundary. Safe to call any number of times.
   */
  cancel(reason?: string): void {
    if (typeof reason === 'string' && reason.length > 0) this.cancelReason = reason;
    if (!this.controller.signal.aborted) this.controller.abort(this.cancelReason);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async execute(start: Checkpoint): Promise<RunResult> {
    const state = cloneCheckpoint(start);
    this.current = state;
    const detector = new LoopDetector(this.loopThreshold);
    const deadline = this.now() + this.wallClockMs;
    let executed = 0;

    for (;;) {
      if (this.controller.signal.aborted) {
        return this.finish(state, 'cancelled', this.cancelReason, executed);
      }
      if (state.stepIndex >= this.maxSteps) {
        return this.finish(
          state,
          'budget-exceeded',
          `Reached the step budget of ${this.maxSteps} steps. Nothing was lost — it resumes from step ${state.stepIndex}.`,
          executed,
        );
      }
      if (this.now() >= deadline) {
        return this.finish(
          state,
          'timeout',
          `Ran past the ${this.wallClockMs} ms wall-clock limit. Nothing was lost — it resumes from step ${state.stepIndex}.`,
          executed,
        );
      }

      const stepIndex = state.stepIndex;
      this.emit({ type: 'step-started', runId: state.runId, stepIndex, at: this.iso() });

      let result: StepResult;
      try {
        const input: StepInput = {
          runId: state.runId,
          goal: state.goal,
          stepIndex,
          messagesSummary: state.messagesSummary,
          pendingAction: state.pendingAction,
          signal: this.controller.signal,
        };
        result = normalizeStepResult(await this.step(input));
      } catch (error) {
        const message = errorMessage(error);
        this.emit({ type: 'error', runId: state.runId, stepIndex, message, at: this.iso() });
        // The step never completed, so `stepIndex` does not advance: a resume
        // retries it.
        return this.finish(state, 'error', message, executed);
      }

      // A cancel that landed while the step was running wins over its result.
      if (this.controller.signal.aborted) {
        return this.finish(state, 'cancelled', this.cancelReason, executed);
      }

      executed += 1;
      if (typeof result.messagesSummary === 'string') state.messagesSummary = result.messagesSummary;
      state.pendingAction = result.pendingAction ?? null;

      if (state.pendingAction) {
        this.emit({
          type: 'tool',
          runId: state.runId,
          stepIndex,
          tool: state.pendingAction.toolName,
          args: state.pendingAction.args,
          at: this.iso(),
        });
      }
      if (typeof result.text === 'string' && result.text.length > 0) {
        this.emit({
          type: 'tool-result',
          runId: state.runId,
          stepIndex,
          tool: state.pendingAction?.toolName ?? '',
          text: result.text,
          at: this.iso(),
        });
      }

      if (state.pendingAction) {
        const verdict = detector.record(actionSignature(state.pendingAction));
        if (verdict.looped) {
          const explanation = loopExplanation(state.pendingAction, verdict.count);
          this.emit({ type: 'error', runId: state.runId, stepIndex, message: explanation, at: this.iso() });
          state.stepIndex = stepIndex + 1;
          return this.finish(state, 'loop-detected', explanation, executed);
        }
      }

      if (typeof result.error === 'string' && result.error.length > 0) {
        this.emit({ type: 'error', runId: state.runId, stepIndex, message: result.error, at: this.iso() });
        state.stepIndex = stepIndex + 1;
        return this.finish(state, 'error', result.error, executed);
      }

      // The step completed: record it so a resume never repeats it.
      state.stepIndex = stepIndex + 1;

      if (result.awaitingApproval) {
        const action: PendingAction = state.pendingAction ?? {
          toolName: 'unknown',
          args: null,
          pageSignature: '',
        };
        this.emit({ type: 'awaiting-approval', runId: state.runId, stepIndex, action, at: this.iso() });
        return this.finish(state, 'awaiting-approval', 'Paused for the user to approve the next action.', executed);
      }

      if (result.done) {
        return this.finish(state, 'done', 'Goal completed.', executed);
      }
    }
  }

  private async finish(
    state: Checkpoint,
    status: RunStatus,
    message: string,
    executed: number,
  ): Promise<RunResult> {
    this.current = state;
    await this.writeCheckpoint(state);
    this.emit({
      type: 'done',
      runId: state.runId,
      stepIndex: state.stepIndex,
      reason: status,
      message,
      at: this.iso(),
    });
    return {
      runId: state.runId,
      goal: state.goal,
      status,
      stepIndex: state.stepIndex,
      steps: executed,
      message,
      checkpoint: cloneCheckpoint(state),
    };
  }

  private async writeCheckpoint(state: Checkpoint): Promise<void> {
    try {
      await this.storage.save(cloneCheckpoint(state));
    } catch (error) {
      // Losing a checkpoint is serious, but it must not take the whole worker
      // down — surface it on the activity log and carry on.
      this.emit({
        type: 'error',
        runId: state.runId,
        stepIndex: state.stepIndex,
        message: `Checkpoint write failed: ${errorMessage(error)}`,
        at: this.iso(),
      });
    }
  }

  private emit(event: ActivityEvent): void {
    try {
      this.sink?.emit(event);
    } catch {
      // A logger must never break the run it is logging.
    }
  }

  private now(): number {
    const value = this.clock();
    return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}

// ── normalisation (garbage in, never throws out) ────────────────────────────

function isStorage(value: unknown): value is CheckpointStorage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.save === 'function' &&
    typeof candidate.load === 'function' &&
    typeof candidate.latest === 'function'
  );
}

function coerceText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return String(value);
  } catch {
    return '';
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return coerceText(error) || 'Unknown error';
}

function normalizePendingAction(value: unknown): PendingAction | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  return {
    toolName: typeof candidate.toolName === 'string' ? candidate.toolName : 'unknown',
    args: 'args' in candidate ? candidate.args : null,
    pageSignature: typeof candidate.pageSignature === 'string' ? candidate.pageSignature : '',
  };
}

function normalizeStepResult(value: unknown): StepResult {
  if (!value || typeof value !== 'object') return { messagesSummary: '' };
  const candidate = value as Record<string, unknown>;
  const result: StepResult = {
    messagesSummary: typeof candidate.messagesSummary === 'string' ? candidate.messagesSummary : '',
  };
  if (typeof candidate.text === 'string') result.text = candidate.text;
  if (typeof candidate.error === 'string' && candidate.error.length > 0) result.error = candidate.error;
  if (candidate.done === true) result.done = true;
  if (candidate.awaitingApproval === true) result.awaitingApproval = true;
  const action = normalizePendingAction(candidate.pendingAction);
  if (action) result.pendingAction = action;
  return result;
}

/** Turn anything a storage backend handed back into a usable checkpoint. */
export function normalizeCheckpoint(value: unknown): Checkpoint | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.runId !== 'string' || candidate.runId.length === 0) return undefined;
  const stepIndex =
    typeof candidate.stepIndex === 'number' && Number.isFinite(candidate.stepIndex) && candidate.stepIndex >= 0
      ? Math.floor(candidate.stepIndex)
      : 0;
  return {
    runId: candidate.runId,
    goal: typeof candidate.goal === 'string' ? candidate.goal : '',
    stepIndex,
    messagesSummary: typeof candidate.messagesSummary === 'string' ? candidate.messagesSummary : '',
    pendingAction: normalizePendingAction(candidate.pendingAction),
    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date(0).toISOString(),
  };
}

/** A deep-enough copy that callers cannot mutate runtime state. */
export function cloneCheckpoint(checkpoint: Checkpoint): Checkpoint {
  return {
    runId: checkpoint.runId,
    goal: checkpoint.goal,
    stepIndex: checkpoint.stepIndex,
    messagesSummary: checkpoint.messagesSummary,
    pendingAction: checkpoint.pendingAction ? { ...checkpoint.pendingAction } : null,
    createdAt: checkpoint.createdAt,
  };
}

function defaultRunId(): string {
  return `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
