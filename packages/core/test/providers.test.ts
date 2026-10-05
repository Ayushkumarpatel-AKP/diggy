import { describe, expect, it } from 'vitest';
import { generateText, streamText } from 'ai';
import {
  GROQ_BASE_URL,
  GROQ_DEFAULT_MODEL,
  NVIDIA_NIM_DEFAULT_MODEL,
  createGroqModel,
  createProvider,
  getProvider,
  resolveProviderName,
} from '../src/index';
import { createFetchMock, jsonResponse, sseResponse } from './fakes';

describe('provider defaults', () => {
  it('resolves the provider from env, preferring groq when GROQ_API_KEY is set', () => {
    expect(resolveProviderName({ GROQ_API_KEY: 'gk' })).toBe('groq');
    expect(resolveProviderName({ NVIDIA_API_KEY: 'nk' })).toBe('nvidia');
    expect(resolveProviderName({})).toBe('nvidia');
  });

  it('builds groq and nvidia models with the right ids', () => {
    expect(getProvider('groq').provider).toBe('groq');
    expect(getProvider('groq').modelId).toBe(GROQ_DEFAULT_MODEL);
    expect(getProvider('nvidia').provider).toBe('nvidia-nim');
    expect(getProvider('nvidia').modelId).toBe(NVIDIA_NIM_DEFAULT_MODEL);
  });

  it('honours overrides in ProviderConfig', () => {
    const model = createProvider({ name: 'groq', model: 'custom-model', apiKey: 'k' });
    expect(model.modelId).toBe('custom-model');
  });
});

describe('OpenAI-compatible client (mock fetch, no network)', () => {
  it('posts to <baseURL>/chat/completions with bearer auth and parses text', async () => {
    const fetchMock = createFetchMock(async () =>
      jsonResponse({
        id: 'cmpl_1',
        model: GROQ_DEFAULT_MODEL,
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Hi there' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
    );

    const model = createGroqModel({ apiKey: 'test-key', fetch: fetchMock as unknown as typeof fetch });
    const result = await generateText({
      model,
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result.text).toBe('Hi there');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${GROQ_BASE_URL}/chat/completions`);
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe(GROQ_DEFAULT_MODEL);
    expect(body.messages[0]).toEqual({ role: 'user', content: 'hello' });
  });

  it('streams text deltas from an SSE body', async () => {
    const fetchMock = createFetchMock(async () =>
      sseResponse([
        'data: {"choices":[{"index":0,"delta":{"content":"Stre"}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"content":"amed"}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const model = createGroqModel({ apiKey: 'test-key', fetch: fetchMock as unknown as typeof fetch });
    const result = streamText({
      model,
      messages: [{ role: 'user', content: 'stream please' }],
    });

    let text = '';
    for await (const delta of result.textStream) {
      text += delta;
    }
    expect(text).toBe('Streamed');
  });

  it('throws a helpful error on non-ok responses', async () => {
    const fetchMock = createFetchMock(
      async () => new Response('nope', { status: 401, statusText: 'Unauthorized' }),
    );
    const model = createGroqModel({ fetch: fetchMock as unknown as typeof fetch });

    await expect(
      generateText({ model, messages: [{ role: 'user', content: 'x' }], maxRetries: 0 }),
    ).rejects.toThrow(/401/);
  });
});
