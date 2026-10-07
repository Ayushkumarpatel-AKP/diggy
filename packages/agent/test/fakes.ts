/**
 * Test doubles for the agent runtime: a storage that records every write, and a
 * scripted `step()`. No chrome, no network.
 */
import { createMemoryCheckpointStorage } from '../src/index';
import type { Checkpoint, CheckpointStorage, StepFn, StepResult } from '../src/index';

export interface RecordingStorage extends CheckpointStorage {
  /** Every checkpoint handed to `save()`, in order. */
  readonly saved: Checkpoint[];
}

/** An in-memory store that also keeps a log of the checkpoints written. */
export function createRecordingStorage(): RecordingStorage {
  const inner = createMemoryCheckpointStorage();
  const saved: Checkpoint[] = [];
  return {
    saved,
    save(checkpoint: Checkpoint): void {
      saved.push(checkpoint);
      inner.save(checkpoint);
    },
    load(runId: string) {
      return inner.load(runId);
    },
    latest() {
      return inner.latest();
    },
    clear(runId: string): void {
      inner.clear(runId);
    },
  };
}

export interface RecordedStep {
  /** The runtime's step index for this call (continues across a resume). */
  stepIndex: number;
  signal: AbortSignal;
}

export interface ScriptedStep {
  step: StepFn;
  records: RecordedStep[];
}

/**
 * A `step()` that replays a fixed script keyed by call order (the last entry
 * repeats). Records the runtime step index each time.
 */
export function createScriptedStep(script: StepResult[], records: RecordedStep[] = []): ScriptedStep {
  let cursor = 0;
  const step: StepFn = (input) => {
    records.push({ stepIndex: input.stepIndex, signal: input.signal });
    const entry = script[Math.min(cursor, script.length - 1)] ?? {};
    cursor += 1;
    return { ...entry };
  };
  return { step, records };
}
