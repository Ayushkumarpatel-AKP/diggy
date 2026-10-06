/**
 * The Diggy agent loop.
 *
 * A thin, provider-agnostic wrapper over the Vercel AI SDK's `streamText` /
 * `generateText` with tool-calling. The concrete model is injected, so the same
 * loop runs on NVIDIA NIM or Groq (or a test double) with no changes.
 *
 * Note on the AI SDK version: this workspace has `ai@4.x`, which drives the
 * tool-calling loop with `maxSteps` (the v5 `stopWhen: stepCountIs(n)` API is
 * not available here — see the detection step in the task).
 */
import {
  generateText,
  streamText,
  type CoreMessage,
  type GenerateTextResult,
  type LanguageModelV1,
  type StepResult,
  type StreamTextResult,
  type ToolSet,
} from 'ai';
import { MAX_AGENT_STEPS, type ChatMessage } from '@diggy/shared';
import { buildSystemPrompt } from './prompt';
import { buildToolset } from './tools';
import type { ToolContext } from './tools/types';

export interface RunAgentOptions {
  /** Conversation so far (the system prompt is added separately). */
  messages: CoreMessage[];
  /** The language model to use (from `getProvider(...)`). */
  provider: LanguageModelV1;
  /**
   * Tools to expose. When omitted, a full toolset is built from `context`
   * via `buildToolset(context)`.
   */
  tools?: ToolSet;
  /** Host executors the tools delegate to. */
  context: ToolContext;
  /** Override the persona system prompt. Defaults to Diggy's. */
  systemPrompt?: string;
  /** Max sequential LLM calls (tool rounds). Defaults to `MAX_AGENT_STEPS` (8). */
  maxSteps?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
  /** Called after each step (including intermediate tool-call steps). */
  onStepFinish?: (step: StepResult<ToolSet>) => void | Promise<void>;
  /**
   * Called when the underlying model stream errors. The AI SDK otherwise ends
   * the text stream *silently* on an error part, which hides failures — always
   * wire this to a logger.
   */
  onError?: (error: unknown) => void;
}

function resolveTools(options: RunAgentOptions): ToolSet {
  return options.tools ?? buildToolset(options.context);
}

/**
 * Run the agent with streaming. Returns the AI SDK `StreamTextResult`; the host
 * consumes `.textStream` (plain deltas), `.fullStream` (tool events included),
 * or `.toDataStreamResponse()`.
 */
export function runAgent(options: RunAgentOptions): StreamTextResult<ToolSet, never> {
  return streamText({
    model: options.provider,
    system: options.systemPrompt ?? buildSystemPrompt(),
    messages: options.messages,
    tools: resolveTools(options),
    maxSteps: options.maxSteps ?? MAX_AGENT_STEPS,
    temperature: options.temperature,
    abortSignal: options.abortSignal,
    onStepFinish: options.onStepFinish,
    onError: options.onError ? (event) => options.onError?.((event as { error?: unknown }).error ?? event) : undefined,
  }) as StreamTextResult<ToolSet, never>;
}

/**
 * Non-streaming helper. Resolves once the whole tool-calling loop is done.
 * The final assistant text is on the returned `.text`; `.steps`, `.toolCalls`
 * and `.toolResults` expose what happened along the way.
 */
export async function runAgentToText(
  options: RunAgentOptions,
): Promise<GenerateTextResult<ToolSet, never>> {
  return generateText({
    model: options.provider,
    system: options.systemPrompt ?? buildSystemPrompt(),
    messages: options.messages,
    tools: resolveTools(options),
    maxSteps: options.maxSteps ?? MAX_AGENT_STEPS,
    temperature: options.temperature,
    abortSignal: options.abortSignal,
    onStepFinish: options.onStepFinish,
  }) as Promise<GenerateTextResult<ToolSet, never>>;
}

/**
 * Convert a `@diggy/shared` chat history into AI SDK `CoreMessage`s.
 *
 * `system`/`user`/`assistant` map 1:1. A `tool` history entry (which carries no
 * tool-call id in the shared type) is folded into a user-visible note so it is
 * still part of the context without fabricating a tool-call pair.
 */
export function toCoreMessages(history: ChatMessage[]): CoreMessage[] {
  const messages: CoreMessage[] = [];
  for (const message of history) {
    if (message.role === 'system') {
      messages.push({ role: 'system', content: message.content });
    } else if (message.role === 'user') {
      messages.push({ role: 'user', content: message.content });
    } else if (message.role === 'assistant') {
      messages.push({ role: 'assistant', content: message.content });
    } else {
      const label = message.toolName ? ` (${message.toolName})` : '';
      messages.push({ role: 'user', content: `[tool result${label}] ${message.content}` });
    }
  }
  return messages;
}
