/**
 * A checkpoint store that lives in memory. Two uses:
 *   1. tests (no chrome, no IndexedDB);
 *   2. a safe fallback when the host forgets to inject storage, so the runtime
 *      still works (just not durably).
 */
import type { Checkpoint, CheckpointStorage } from './types';

export function createMemoryCheckpointStorage(): CheckpointStorage {
  const byRun = new Map<string, Checkpoint>();
  let last: Checkpoint | undefined;

  return {
    save(checkpoint: Checkpoint): void {
      byRun.set(checkpoint.runId, checkpoint);
      last = checkpoint;
    },
    load(runId: string): Checkpoint | undefined {
      return byRun.get(runId);
    },
    latest(): Checkpoint | undefined {
      return last;
    },
    clear(runId: string): void {
      byRun.delete(runId);
      if (last && last.runId === runId) last = undefined;
    },
  };
}
