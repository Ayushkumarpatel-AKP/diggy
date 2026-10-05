/**
 * Minimal OpenAI-compatible chat-completions client.
 *
 * ## Why this exists (documented limitation)
 * The plan (§4.2) asks for thin OpenAI-compatible providers built on the Vercel
 * AI SDK. The canonical way to do that is `@ai-sdk/openai-compatible`, but that
 * package is **not installed** in this workspace and we are not allowed to add
 * dependencies. Instead of depending on a package that isn't there, this module
 * implements a *minimal* OpenAI-compatible model that satisfies the AI SDK's
 * `LanguageModelV1` interface, so `streamText` / `generateText` / `tool()` and
 * the rest of the orchestrator work unchanged.
 *
 * Limitations vs. `@ai-sdk/openai-compatible`:
 *  - Only text + function/tool-calling are supported (no images, files, audio,
 *    structured-output JSON mode, or reasoning parts).
 *  - Only `chat/completions` (no responses API, no embeddings).
 *  - No retry/back-off or provider-metadata passthrough.
 *
 * The public factory `createOpenAICompatible(...)` mirrors the shape of the real
 * `@ai-sdk/openai-compatible` provider (`provider(modelId)` plus
 * `provider.languageModel` / `provider.chatModel`), and
 * `createOpenAICompatibleModel(...)` returns a ready-to-use model. Because the
 * returned object is a real `LanguageModelV1`, swapping NVIDIA NIM <-> Groq is
 * *only* a change of `baseURL` + `model` (+ api key), as required.
 */
import type {
  FinishReason,
  LanguageModelV1,
  LanguageModelV1CallOptions,
  LanguageModelV1Prompt,
  LanguageModelV1StreamPart,
} from 'ai';

// --- Types derived from the imported interfaces -----------------------------
// `ai` only re-exports a subset of @ai-sdk/provider, so we derive the tool/part
// shapes we need from the public interfaces instead of importing them directly.

type DoGenerateResult = Awaited<ReturnType<LanguageModelV1['doGenerate']>>;
type ToolCallPart = NonNullable<DoGenerateResult['toolCalls']>[number];
type RegularMode = Extract<LanguageModelV1CallOptions['mode'], { type: 'regular' }>;
type ToolDef = NonNullable<NonNullable<RegularMode['tools']>[number]>;
type FunctionToolDef = Extract<ToolDef, { type: 'function' }>;

/** Minimal shape of an OpenAI-compatible chat message. */
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

/** Minimal shape of an OpenAI-compatible chat-completion response. */
interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface OpenAICompatibleModelConfig {
  /** Provider name used for logging/telemetry, e.g. `nvidia-nim` or `groq`. */
  provider: string;
  /** The concrete model id, e.g. `meta/llama-3.3-70b-instruct`. */
  modelId: string;
  /** API base URL including the version segment, e.g. `https://api.groq.com/openai/v1`. */
  baseURL: string;
  /** Bearer token. Optional so local/compatible servers without auth still work. */
  apiKey?: string;
  /** Extra headers merged onto every request. */
  headers?: Record<string, string>;
  /** Injectable fetch implementation (used by tests); defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface OpenAICompatibleConfig {
  /** Provider name, e.g. `nvidia-nim`. */
  name: string;
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

/**
 * A provider instance, mirroring the callable shape of
 * `@ai-sdk/openai-compatible`'s `createOpenAICompatible` return value.
 */
export interface OpenAICompatibleProvider {
  (modelId: string): LanguageModelV1;
  languageModel(modelId: string): LanguageModelV1;
  chatModel(modelId: string): LanguageModelV1;
}

function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
      return 'tool-calls';
    case 'content_filter':
      return 'content-filter';
    case null:
    case undefined:
      return 'unknown';
    default:
      return 'other';
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? null) ?? 'null';
  } catch {
    return String(value);
  }
}

function partsToText(
  parts: ReadonlyArray<{ type: string; text?: string }>,
): string {
  return parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('');
}

/** Convert an AI SDK `LanguageModelV1Prompt` into OpenAI chat messages. */
export function toOpenAIMessages(prompt: LanguageModelV1Prompt): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];

  for (const message of prompt) {
    switch (message.role) {
      case 'system':
        messages.push({ role: 'system', content: message.content });
        break;
      case 'user':
        messages.push({ role: 'user', content: partsToText(message.content) });
        break;
      case 'assistant': {
        const text = partsToText(message.content);
        const toolCalls = message.content
          .filter((part) => part.type === 'tool-call')
          .map((part) => ({
            id: part.toolCallId,
            type: 'function' as const,
            function: { name: part.toolName, arguments: stringify(part.args) },
          }));
        messages.push({
          role: 'assistant',
          content: text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
        break;
      }
      case 'tool': {
        for (const part of message.content) {
          messages.push({
            role: 'tool',
            content: stringify(part.result),
            tool_call_id: part.toolCallId,
            name: part.toolName,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  return messages;
}

/**
 * Translate the AI SDK's `toolChoice` into the OpenAI wire format Groq/NIM
 * expect. The SDK uses `{ type: 'auto' }` / `{ type: 'tool', toolName }`, which
 * OpenAI-compatible servers reject with a 400.
 */
function mapToolChoice(choice: unknown): unknown {
  if (!choice) return undefined;
  if (typeof choice === 'string') {
    return choice === 'auto' || choice === 'none' || choice === 'required' ? choice : undefined;
  }
  const value = choice as { type?: string; toolName?: string };
  switch (value.type) {
    case 'auto':
      return 'auto';
    case 'none':
      return 'none';
    case 'required':
      return 'required';
    case 'tool':
      return value.toolName ? { type: 'function', function: { name: value.toolName } } : undefined;
    default:
      return undefined;
  }
}

function collectTools(
  options: LanguageModelV1CallOptions,
): { tools?: unknown[]; toolChoice?: unknown } {
  if (options.mode.type !== 'regular') return {};
  const defs = (options.mode.tools ?? []).filter(
    (tool): tool is FunctionToolDef => tool.type === 'function',
  );
  if (defs.length === 0) return { tools: undefined, toolChoice: undefined };
  return {
    tools: defs.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    })),
    toolChoice: mapToolChoice(options.mode.toolChoice),
  };
}

/**
 * A minimal `LanguageModelV1` implementation that speaks the OpenAI
 * `/chat/completions` protocol (works with NVIDIA NIM and Groq alike).
 */
export class OpenAICompatibleChatModel implements LanguageModelV1 {
  readonly specificationVersion = 'v1' as const;
  readonly provider: string;
  readonly modelId: string;
  readonly defaultObjectGenerationMode = undefined;
  readonly supportsImageUrls = false;
  readonly supportsStructuredOutputs = false;

  private readonly baseURL: string;
  private readonly apiKey: string | undefined;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenAICompatibleModelConfig) {
    this.provider = config.provider;
    this.modelId = config.modelId;
    this.baseURL = config.baseURL.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.extraHeaders = config.headers ?? {};
    const fetchImpl = config.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error(
        'No fetch implementation available. Pass `fetch` in the model config.',
      );
    }
    // Bind to globalThis: calling the unbound native `fetch` as a method (via
    // `this.fetchImpl(...)`) throws "Illegal invocation" in browsers.
    this.fetchImpl = fetchImpl.bind(globalThis);
  }

  private buildBody(
    options: LanguageModelV1CallOptions,
    stream: boolean,
  ): Record<string, unknown> {
    const messages = toOpenAIMessages(options.prompt);
    const { tools, toolChoice } = collectTools(options);

    const body: Record<string, unknown> = {
      model: this.modelId,
      messages,
      stream,
    };

    // gpt-oss models stream a long "reasoning" preamble before the answer; on
    // some hosts (e.g. NVIDIA NIM) that can swallow the whole reply and leave
    // `content` empty. Ask for minimal reasoning so the answer actually flows
    // (it also cuts token usage, which helps with rate limits).
    if (/gpt-oss/i.test(this.modelId)) {
      body.reasoning_effort = 'low';
    }

    if (options.maxTokens != null) body.max_tokens = options.maxTokens;
    if (options.temperature != null) body.temperature = options.temperature;
    if (options.topP != null) body.top_p = options.topP;
    if (options.topK != null) body.top_k = options.topK;
    if (options.frequencyPenalty != null) body.frequency_penalty = options.frequencyPenalty;
    if (options.presencePenalty != null) body.presence_penalty = options.presencePenalty;
    if (options.seed != null) body.seed = options.seed;
    if (options.stopSequences && options.stopSequences.length > 0) {
      body.stop = options.stopSequences;
    }
    if (tools) body.tools = tools;
    if (tools && toolChoice) body.tool_choice = toolChoice;

    return body;
  }

  private requestHeaders(
    optionHeaders?: Record<string, string | undefined>,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.extraHeaders,
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (optionHeaders) {
      for (const [key, value] of Object.entries(optionHeaders)) {
        if (value !== undefined) headers[key] = value;
      }
    }
    return headers;
  }

  private call(
    body: Record<string, unknown>,
    options: LanguageModelV1CallOptions,
  ): Promise<Response> {
    return this.fetchImpl(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: this.requestHeaders(options.headers),
      body: JSON.stringify(body),
      signal: options.abortSignal,
    });
  }

  async doGenerate(options: LanguageModelV1CallOptions): Promise<DoGenerateResult> {
    const body = this.buildBody(options, false);
    const response = await this.call(body, options);

    if (!response.ok) {
      const text = await safeText(response);
      throw new Error(
        `${this.provider} request failed (${response.status} ${response.statusText}): ${text}`,
      );
    }

    const json = (await response.json()) as ChatCompletionResponse;
    const choice = json.choices?.[0];
    const message = choice?.message ?? {};
    const text = typeof message.content === 'string' ? message.content : '';

    const toolCalls: ToolCallPart[] = (message.tool_calls ?? []).map((call, index) => ({
      toolCallType: 'function',
      toolCallId: call.id ?? `call_${index}`,
      toolName: call.function?.name ?? '',
      args: call.function?.arguments ?? '{}',
    }));

    const finishReason: FinishReason =
      toolCalls.length > 0 ? 'tool-calls' : mapFinishReason(choice?.finish_reason);

    return {
      text: text.length > 0 ? text : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason,
      usage: {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
      },
      rawCall: { rawPrompt: body, rawSettings: {} },
      rawResponse: { headers: headersToObject(response.headers), body: json },
      request: { body: JSON.stringify(body) },
      response: {
        id: json.id,
        modelId: json.model ?? this.modelId,
        timestamp: new Date(),
      },
      warnings: [],
    };
  }

  async doStream(
    options: LanguageModelV1CallOptions,
  ): Promise<{ stream: ReadableStream<LanguageModelV1StreamPart>; rawCall: { rawPrompt: unknown; rawSettings: Record<string, unknown> }; request?: { body?: string }; warnings?: [] }> {
    const body = this.buildBody(options, true);
    const response = await this.call(body, options);

    if (!response.ok || !response.body) {
      const text = response.body ? await safeText(response) : 'empty response body';
      throw new Error(
        `${this.provider} stream request failed (${response.status} ${response.statusText}): ${text}`,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    const stream = new ReadableStream<LanguageModelV1StreamPart>({
      async start(controller) {
        const toolAccumulator = new Map<number, { id: string; name: string; args: string }>();
        let finishReason: FinishReason = 'unknown';
        let usage = { promptTokens: 0, completionTokens: 0 };
        let buffer = '';

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const rawLine of lines) {
              const line = rawLine.trim();
              if (!line.startsWith('data:')) continue;
              const payload = line.slice('data:'.length).trim();
              if (payload.length === 0 || payload === '[DONE]') continue;

              let chunk: any;
              try {
                chunk = JSON.parse(payload);
              } catch {
                continue;
              }

              if (chunk?.usage) {
                usage = {
                  promptTokens: chunk.usage.prompt_tokens ?? 0,
                  completionTokens: chunk.usage.completion_tokens ?? 0,
                };
              }

              const choice = chunk?.choices?.[0];
              if (!choice) continue;
              const delta = choice.delta ?? {};

              if (typeof delta.content === 'string' && delta.content.length > 0) {
                controller.enqueue({ type: 'text-delta', textDelta: delta.content });
              }

              if (Array.isArray(delta.tool_calls)) {
                for (const call of delta.tool_calls) {
                  const index: number = call.index ?? 0;
                  let entry = toolAccumulator.get(index);
                  if (!entry) {
                    entry = { id: '', name: '', args: '' };
                    toolAccumulator.set(index, entry);
                  }
                  if (call.id) entry.id = call.id;
                  if (call.function?.name) entry.name = call.function.name;
                  if (call.function?.arguments) {
                    entry.args += call.function.arguments;
                    controller.enqueue({
                      type: 'tool-call-delta',
                      toolCallType: 'function',
                      toolCallId: entry.id || `call_${index}`,
                      toolName: entry.name,
                      argsTextDelta: call.function.arguments,
                    });
                  }
                }
              }

              if (choice.finish_reason) {
                finishReason = mapFinishReason(choice.finish_reason);
              }
            }
          }

          if (toolAccumulator.size > 0) {
            finishReason = 'tool-calls';
            for (const [index, entry] of toolAccumulator) {
              controller.enqueue({
                type: 'tool-call',
                toolCallType: 'function',
                toolCallId: entry.id || `call_${index}`,
                toolName: entry.name,
                args: entry.args || '{}',
              });
            }
          }

          controller.enqueue({ type: 'finish', finishReason, usage });
          controller.close();
        } catch (error) {
          controller.enqueue({ type: 'error', error });
          controller.close();
        }
      },
    });

    return {
      stream,
      rawCall: { rawPrompt: body, rawSettings: {} },
      request: { body: JSON.stringify(body) },
      warnings: [],
    };
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable body>';
  }
}

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

/** Create a single ready-to-use OpenAI-compatible model. */
export function createOpenAICompatibleModel(
  config: OpenAICompatibleModelConfig,
): LanguageModelV1 {
  return new OpenAICompatibleChatModel(config);
}

/**
 * Create an `@ai-sdk/openai-compatible`-style provider, i.e. a callable that
 * accepts a model id and returns a `LanguageModelV1`.
 */
export function createOpenAICompatible(
  config: OpenAICompatibleConfig,
): OpenAICompatibleProvider {
  const provider = (modelId: string): LanguageModelV1 =>
    createOpenAICompatibleModel({
      provider: config.name,
      modelId,
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      headers: config.headers,
      fetch: config.fetch,
    });

  return Object.assign(provider, {
    languageModel: provider,
    chatModel: provider,
  });
}
