/**
 * Test doubles: a scripted `LanguageModelV1` (no network) and a mock
 * `ToolContext` whose executors are vitest spies.
 */
import { vi } from 'vitest';
import type {
  FinishReason,
  LanguageModelV1,
  LanguageModelV1CallOptions,
  LanguageModelV1StreamPart,
} from 'ai';
import type { PageContext, Reminder } from '@diggy/shared';
import type { ToolContext } from '../src/index';

export interface ScriptedToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ScriptedStep {
  text?: string;
  toolCalls?: ScriptedToolCall[];
  finishReason?: FinishReason;
}

export type ScriptedModel = LanguageModelV1 & {
  calls: LanguageModelV1CallOptions[];
};

/**
 * A `LanguageModelV1` that replays a fixed script of steps and records every
 * call it receives — so the full AI SDK tool loop runs without any network.
 */
export function createScriptedModel(steps: ScriptedStep[]): ScriptedModel {
  const calls: LanguageModelV1CallOptions[] = [];
  let index = 0;

  const nextStep = (): ScriptedStep => {
    const step = steps[Math.min(index, steps.length - 1)] ?? { text: '' };
    index += 1;
    return step;
  };

  const model: LanguageModelV1 = {
    specificationVersion: 'v1',
    provider: 'test',
    modelId: 'test-model',
    defaultObjectGenerationMode: undefined,

    async doGenerate(options: LanguageModelV1CallOptions) {
      calls.push(options);
      const step = nextStep();
      const toolCalls = (step.toolCalls ?? []).map((call) => ({
        toolCallType: 'function' as const,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        args: JSON.stringify(call.args),
      }));
      const finishReason: FinishReason =
        step.finishReason ?? (toolCalls.length > 0 ? 'tool-calls' : 'stop');
      return {
        text: step.text,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason,
        usage: { promptTokens: 1, completionTokens: 1 },
        rawCall: { rawPrompt: options.prompt, rawSettings: {} },
        warnings: [],
      };
    },

    async doStream(options: LanguageModelV1CallOptions) {
      calls.push(options);
      const step = nextStep();
      const parts: LanguageModelV1StreamPart[] = [];
      if (step.text) parts.push({ type: 'text-delta', textDelta: step.text });
      for (const call of step.toolCalls ?? []) {
        parts.push({
          type: 'tool-call',
          toolCallType: 'function',
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          args: JSON.stringify(call.args),
        });
      }
      const finishReason: FinishReason =
        step.finishReason ?? ((step.toolCalls?.length ?? 0) > 0 ? 'tool-calls' : 'stop');
      parts.push({
        type: 'finish',
        finishReason,
        usage: { promptTokens: 1, completionTokens: 1 },
      });

      const stream = new ReadableStream<LanguageModelV1StreamPart>({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      });

      return {
        stream,
        rawCall: { rawPrompt: options.prompt, rawSettings: {} },
        warnings: [],
      };
    },
  };

  return Object.assign(model, { calls });
}

/** Mock ToolContext: every executor is a spy returning a valid result. */
export function createMockContext() {
  const context = {
    readPage: vi.fn(
      async (): Promise<PageContext> => ({
        url: 'https://example.com',
        title: 'Example',
        text: 'hello world',
      }),
    ),
    fillForm: vi.fn(async () => ({ filled: 0, skipped: [] as string[] })),
    getProfile: vi.fn(async () => ({})),
    createReminder: vi.fn(
      async (): Promise<Reminder> => ({
        id: 'rem_1',
        title: 'stub',
        dueAt: '2025-01-01T00:00:00.000Z',
        status: 'pending',
        createdAt: new Date(0).toISOString(),
      }),
    ),
    listReminders: vi.fn(async (): Promise<Reminder[]> => []),
    crawl: vi.fn(
      async (): Promise<Array<{ url: string; title: string; markdown: string }>> => [],
    ),
    searchWeb: vi.fn(
      async (): Promise<Array<{ title: string; url: string; snippet: string }>> => [],
    ),
    notify: vi.fn(async () => undefined),
    speak: vi.fn(async () => undefined),
    setMood: vi.fn(async () => undefined),
    playAnim: vi.fn(async () => undefined),
  };

  return context as unknown as ToolContext & typeof context;
}

/** A `fetch`-shaped function usable as a typed vitest mock. */
export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** `vi.fn` typed as a fetch implementation so `mock.calls` is well-typed. */
export function createFetchMock(impl: FetchFn) {
  return vi.fn<FetchFn>(impl);
}

/** Build a `Response` with a JSON body. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Build a `Response` whose body is an SSE stream. */
export function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}
