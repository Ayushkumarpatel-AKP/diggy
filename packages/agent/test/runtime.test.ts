import { describe, expect, it } from 'vitest';
import {
  AgentRuntime,
  DEFAULT_LOOP_THRESHOLD,
  DEFAULT_MAX_STEPS,
  DEFAULT_WALL_CLOCK_MS,
  LoopDetector,
  actionSignature,
  createMemoryCheckpointStorage,
  createMemorySink,
  type ActivityEvent,
  type Checkpoint,
  type StepInput,
  type StepResult,
} from '../src/index';
import { createRecordingStorage, createScriptedStep } from './fakes';

describe('AgentRuntime — checkpoints', () => {
  it('writes and reads back a full checkpoint through the injected storage', async () => {
    const storage = createRecordingStorage();
    const { step } = createScriptedStep([{ messagesSummary: 'did the thing', done: true }]);
    const runtime = new AgentRuntime({ storage, step, clock: () => 1000 });

    const result = await runtime.run('Summarise my inbox', { runId: 'run_roundtrip' });

    expect(result.status).toBe('done');
    expect(result.runId).toBe('run_roundtrip');
    expect(result.stepIndex).toBe(1);
    expect(result.steps).toBe(1);
    expect(storage.saved.length).toBeGreaterThanOrEqual(2); // the start + the final

    const saved = await storage.latest();
    expect(saved).toEqual(result.checkpoint);
    expect(saved).toEqual({
      runId: 'run_roundtrip',
      goal: 'Summarise my inbox',
      stepIndex: 1,
      messagesSummary: 'did the thing',
      pendingAction: null,
      createdAt: new Date(1000).toISOString(),
    });
  });

  it('defaults to a 20-step budget and a 2-minute wall clock', async () => {
    let steps = 0;
    const runtime = new AgentRuntime({
      storage: createMemoryCheckpointStorage(),
      clock: () => 0,
      step: async () => {
        steps += 1;
        return {};
      },
    });

    const result = await runtime.run('count forever');

    expect(result.status).toBe('budget-exceeded');
    expect(steps).toBe(20);
    expect(DEFAULT_MAX_STEPS).toBe(20);
    expect(DEFAULT_WALL_CLOCK_MS).toBe(120_000);
  });
});

describe('AgentRuntime — resume', () => {
  it('continues from the last checkpoint and never repeats a completed step', async () => {
    const storage = createRecordingStorage();
    const records: number[] = [];
    const step = async ({ stepIndex }: StepInput): Promise<StepResult> => {
      records.push(stepIndex);
      return { messagesSummary: `step ${stepIndex}` };
    };

    const first = new AgentRuntime({ storage, step, budget: { maxSteps: 2 }, clock: () => 0 });
    const firstResult = await first.run('a long job');

    expect(firstResult.status).toBe('budget-exceeded');
    expect(records).toEqual([0, 1]);
    expect(firstResult.stepIndex).toBe(2);

    // A "worker wake": a brand new runtime, the same storage.
    records.length = 0;
    const second = new AgentRuntime({ storage, step, budget: { maxSteps: 5 }, clock: () => 0 });
    const resumed = await second.resume();

    expect(resumed.status).toBe('budget-exceeded');
    expect(resumed.stepIndex).toBe(5);
    expect(records).toEqual([2, 3, 4]); // 0 and 1 are never revisited
    expect(records.every((index) => index >= 2)).toBe(true);
    expect(resumed.checkpoint.messagesSummary).toBe('step 4');
  });

  it('is a clean no-op when there is no checkpoint', async () => {
    const runtime = new AgentRuntime({
      storage: createMemoryCheckpointStorage(),
      step: async () => ({ done: true }),
      clock: () => 0,
    });
    const result = await runtime.resume();
    expect(result.status).toBe('no-checkpoint');
    expect(result.stepIndex).toBe(0);
    expect(result.message).toMatch(/nothing to resume/i);
  });

  it('ignores a malformed stored checkpoint instead of throwing', async () => {
    const storage = createMemoryCheckpointStorage();
    await storage.save({ nope: true } as unknown as Checkpoint);
    const runtime = new AgentRuntime({ storage, step: async () => ({ done: true }), clock: () => 0 });
    const result = await runtime.resume();
    expect(result.status).toBe('no-checkpoint');
  });
});

describe('AgentRuntime — cancellation', () => {
  it('aborts end to end through the signal and is safe to call twice', async () => {
    const storage = createMemoryCheckpointStorage();
    let seen: AbortSignal | undefined;
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });

    const step = ({ signal }: StepInput): Promise<StepResult> =>
      new Promise<StepResult>((resolve) => {
        seen = signal;
        enter();
        signal.addEventListener('abort', () => resolve({ messagesSummary: 'aborted' }));
      });

    const runtime = new AgentRuntime({ storage, step, clock: () => 0 });
    const pending = runtime.run('wait for the user');
    await entered;

    runtime.cancel('user pressed stop');
    expect(() => runtime.cancel('user pressed stop')).not.toThrow(); // idempotent

    const result = await pending;
    expect(result.status).toBe('cancelled');
    expect(result.message).toBe('user pressed stop');
    expect(seen?.aborted).toBe(true);
    expect(runtime.signal.aborted).toBe(true);
  });
});

describe('AgentRuntime — budgets', () => {
  it('aborts at the step budget', async () => {
    const records: number[] = [];
    const step = async ({ stepIndex }: StepInput): Promise<StepResult> => {
      records.push(stepIndex);
      return {};
    };
    const runtime = new AgentRuntime({
      storage: createMemoryCheckpointStorage(),
      step,
      budget: { maxSteps: 3 },
      clock: () => 0,
    });

    const result = await runtime.run('endless');

    expect(result.status).toBe('budget-exceeded');
    expect(records).toEqual([0, 1, 2]);
    expect(result.stepIndex).toBe(3);
    expect(result.message).toMatch(/step budget of 3/i);
  });

  it('aborts when the wall-clock limit is exceeded', async () => {
    let now = 0;
    const records: number[] = [];
    const step = async ({ stepIndex }: StepInput): Promise<StepResult> => {
      records.push(stepIndex);
      now += 1000;
      return {};
    };
    const runtime = new AgentRuntime({
      storage: createMemoryCheckpointStorage(),
      step,
      budget: { maxSteps: 100, wallClockMs: 2500 },
      clock: () => now,
    });

    const result = await runtime.run('too slow');

    expect(result.status).toBe('timeout');
    expect(records).toEqual([0, 1, 2]);
    expect(result.message).toMatch(/wall-clock limit/i);
  });

  it('does not record a step that threw — it stays resumable', async () => {
    const storage = createRecordingStorage();
    const runtime = new AgentRuntime({
      storage,
      clock: () => 0,
      step: async () => {
        throw new Error('kaboom');
      },
    });

    const result = await runtime.run('crash');
    expect(result.status).toBe('error');
    expect(result.message).toBe('kaboom');
    expect(result.stepIndex).toBe(0);
  });
});

describe('AgentRuntime — loop detection', () => {
  it('fires exactly on the third identical action, not before', async () => {
    const action = {
      toolName: 'readPage',
      args: { url: 'https://example.com' },
      pageSignature: 'https://example.com',
    };
    const records: number[] = [];
    const step = async ({ stepIndex }: StepInput): Promise<StepResult> => {
      records.push(stepIndex);
      return { messagesSummary: 'reading', pendingAction: { ...action } };
    };

    const runtime = new AgentRuntime({
      storage: createMemoryCheckpointStorage(),
      step,
      budget: { maxSteps: 10 },
      clock: () => 0,
    });

    const result = await runtime.run('read the page');

    expect(result.status).toBe('loop-detected');
    expect(records).toEqual([0, 1, 2]); // it ran a 3rd time, it did not stop at the 2nd
    expect(result.stepIndex).toBe(3);
    expect(result.message).toMatch(/repeated the same action 3 times/i);
    expect(result.message).toMatch(/readPage/);
  });

  it('does not fire when the action changes each step', async () => {
    const step = async ({ stepIndex }: StepInput): Promise<StepResult> => ({
      messagesSummary: `step ${stepIndex}`,
      pendingAction: { toolName: 'readPage', args: { page: stepIndex }, pageSignature: `p${stepIndex}` },
    });
    const runtime = new AgentRuntime({
      storage: createMemoryCheckpointStorage(),
      step,
      budget: { maxSteps: 4 },
      clock: () => 0,
    });
    const result = await runtime.run('read many pages');
    expect(result.status).toBe('budget-exceeded');
  });
});

describe('LoopDetector', () => {
  it('does not fire before the threshold', () => {
    const detector = new LoopDetector();
    expect(DEFAULT_LOOP_THRESHOLD).toBe(3);
    expect(detector.record('a').looped).toBe(false);
    expect(detector.record('a').looped).toBe(false);
    expect(detector.record('a').looped).toBe(true);
  });

  it('keys on tool + args + page signature and survives garbage args', () => {
    const base = { toolName: 'readPage', args: { url: 'x' }, pageSignature: 'p' };
    const reordered = { toolName: 'readPage', args: { url: 'x' }, pageSignature: 'p' };
    expect(actionSignature(base)).toBe(actionSignature(reordered));
    expect(actionSignature({ ...base, pageSignature: 'other' })).not.toBe(actionSignature(base));

    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => actionSignature({ toolName: 't', args: cyclic, pageSignature: '' })).not.toThrow();
    expect(() => actionSignature(null)).not.toThrow();
  });
});

describe('AgentRuntime — activity log', () => {
  it('emits a typed activity log through the injected sink', async () => {
    const sink = createMemorySink();
    const step = async ({ stepIndex }: StepInput): Promise<StepResult> =>
      stepIndex === 0
        ? {
            messagesSummary: 'called readPage',
            pendingAction: { toolName: 'readPage', args: { url: 'https://x' }, pageSignature: 'https://x' },
            text: 'hello world',
          }
        : { done: true, messagesSummary: 'finished' };

    const runtime = new AgentRuntime({
      storage: createMemoryCheckpointStorage(),
      step,
      sink,
      clock: () => 0,
    });
    await runtime.run('read then finish');

    expect(sink.events.map((event: ActivityEvent) => event.type)).toEqual([
      'step-started',
      'tool',
      'tool-result',
      'step-started',
      'done',
    ]);
    const tool = sink.events.find((event) => event.type === 'tool');
    expect(tool && tool.type === 'tool' ? tool.tool : undefined).toBe('readPage');
    const last = sink.events.at(-1);
    expect(last && last.type === 'done' ? last.reason : undefined).toBe('done');
  });

  it('emits awaiting-approval and error events', async () => {
    const approvalSink = createMemorySink();
    const approval = new AgentRuntime({
      storage: createMemoryCheckpointStorage(),
      sink: approvalSink,
      clock: () => 0,
      step: async () => ({
        messagesSummary: 'wants to fill a form',
        pendingAction: { toolName: 'fillForm', args: {}, pageSignature: 'p' },
        awaitingApproval: true,
      }),
    });
    const approvalResult = await approval.run('fill it');
    expect(approvalResult.status).toBe('awaiting-approval');
    expect(approvalSink.events.map((event) => event.type)).toEqual([
      'step-started',
      'tool',
      'awaiting-approval',
      'done',
    ]);

    const errorSink = createMemorySink();
    const errored = new AgentRuntime({
      storage: createMemoryCheckpointStorage(),
      sink: errorSink,
      clock: () => 0,
      step: async () => ({ error: 'provider exploded' }),
    });
    const errorResult = await errored.run('boom');
    expect(errorResult.status).toBe('error');
    expect(errorResult.message).toBe('provider exploded');
    expect(errorSink.events.map((event) => event.type)).toEqual(['step-started', 'error', 'done']);
  });

  it('never throws on a garbage step result', async () => {
    const runtime = new AgentRuntime({
      storage: createMemoryCheckpointStorage(),
      clock: () => 0,
      budget: { maxSteps: 2 },
      step: async () => undefined as unknown as StepResult,
    });
    const result = await runtime.run('garbage');
    expect(result.status).toBe('budget-exceeded');
  });
});
