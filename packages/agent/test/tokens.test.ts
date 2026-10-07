import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_SUMMARY_PREFIX,
  DEFAULT_KEEP_RECENT,
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  capToolResult,
  chunkText,
  summarizeConversation,
  summarizeLongText,
  type AgentMessage,
  type SummarizeRequest,
} from '../src/index';

describe('capToolResult', () => {
  it('leaves short text untouched', () => {
    expect(capToolResult('hello world', 100)).toBe('hello world');
    expect(capToolResult('exactly-five', 12)).toBe('exactly-five');
    expect(DEFAULT_MAX_TOOL_RESULT_CHARS).toBe(4000);
  });

  it('truncates long text with a marker that reports the elided count', () => {
    const text = 'a'.repeat(500);
    const capped = capToolResult(text, 100);

    expect(capped).not.toBe(text);
    expect(capped.length).toBeLessThanOrEqual(100);
    expect(capped).toContain('[truncated');
    expect(capped).toContain('more characters]');
    expect(capped.startsWith('a'.repeat(40))).toBe(true);
    // 100 - 48 reserve = 52 chars of head, so 448 were elided.
    expect(capped).toContain('448 more characters');
  });

  it('never throws on garbage input', () => {
    expect(capToolResult(null, 10)).toBe('');
    expect(capToolResult(undefined, 10)).toBe('');
    expect(capToolResult(12345 as unknown as string, 10)).toBe('12345');
    expect(capToolResult('abc', Number.NaN)).toBe('abc');
    expect(capToolResult('abc', -1)).toBe('abc');
    expect(capToolResult('abc', 0)).toBe('');
  });
});

describe('chunkText', () => {
  it('always makes progress and never loops', () => {
    const chunks = chunkText('x'.repeat(250), 100);
    expect(chunks).toEqual(['x'.repeat(100), 'x'.repeat(100), 'x'.repeat(50)]);
    expect(chunkText('', 10)).toEqual([]);
    expect(chunkText('abc', 0)).toEqual(['abc']); // invalid size falls back, no infinite loop
  });
});

describe('summarizeLongText (map-reduce contract)', () => {
  it('maps every chunk and then reduces the partials', async () => {
    const mapIndexes: number[] = [];
    const reduceIndexes: number[] = [];
    const model = (request: SummarizeRequest): string => {
      if (request.kind === 'map') mapIndexes.push(request.index);
      else reduceIndexes.push(request.index);
      return `[${request.kind}:${request.text.length}]`;
    };

    const result = await summarizeLongText('x'.repeat(250), { model, chunkChars: 100 });

    expect(result.chunks).toBe(3);
    expect(mapIndexes).toEqual([0, 1, 2]);
    expect(reduceIndexes.length).toBeGreaterThanOrEqual(1);
    expect(result.rounds).toBe(1);
    expect(result.viaModel).toBe(true);
    // map gave `[map:100]`, `[map:100]`, `[map:50]` → joined = 30 chars → one reduce.
    expect(result.summary).toBe('[reduce:30]');
  });

  it('does a single map call for text that fits in one chunk', async () => {
    const result = await summarizeLongText('short text', { model: () => 'SUMMARY', chunkChars: 100 });
    expect(result.summary).toBe('SUMMARY');
    expect(result.chunks).toBe(1);
    expect(result.rounds).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('reads back empty/garbage input without calling the model', async () => {
    let calls = 0;
    const model = (): string => {
      calls += 1;
      return 'x';
    };
    expect((await summarizeLongText('', { model })).summary).toBe('');
    expect((await summarizeLongText(null, { model })).summary).toBe('');
    expect((await summarizeLongText('   ', { model })).viaModel).toBe(false);
    expect(calls).toBe(0);
  });

  it('caps the number of chunks it will read', async () => {
    const result = await summarizeLongText('y'.repeat(1000), { model: () => 's', chunkChars: 10, maxChunks: 4 });
    expect(result.chunks).toBe(4);
    expect(result.truncated).toBe(true);
  });

  it('honours the abort signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(summarizeLongText('hello world', { model: () => 'x', signal: controller.signal })).rejects.toThrow();
  });
});

describe('summarizeConversation', () => {
  const history = (count: number): AgentMessage[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `id${index}`,
      role: index % 2 === 1 ? 'assistant' : 'user',
      content: `msg ${index}`,
      createdAt: '2025-01-01T00:00:00.000Z',
    }));

  it('folds old messages into one summary and keeps the recent tail', async () => {
    const model = (request: SummarizeRequest): string => `sum(${request.kind})`;
    const result = await summarizeConversation(history(10), { model, keepRecent: 4, chunkChars: 1000 });

    expect(result.summarized).toBe(true);
    expect(result.dropped).toBe(6);
    expect(result.messages).toHaveLength(5); // 1 summary + 4 recent
    expect(result.messages[0]?.role).toBe('system');
    expect(result.messages[0]?.content).toContain(CONVERSATION_SUMMARY_PREFIX);
    expect(result.messages[0]?.content).toContain('sum(map)');
    expect(result.messages.at(-1)?.content).toBe('msg 9');
  });

  it('leaves short histories untouched and never calls the model', async () => {
    let calls = 0;
    const model = (): string => {
      calls += 1;
      return 'x';
    };
    const result = await summarizeConversation(history(2), { model, keepRecent: DEFAULT_KEEP_RECENT });
    expect(result.summarized).toBe(false);
    expect(result.messages).toHaveLength(2);
    expect(calls).toBe(0);
  });

  it('never throws on a garbage history', async () => {
    const result = await summarizeConversation(null, { model: () => 'x' });
    expect(result.messages).toEqual([]);
    expect(result.summarized).toBe(false);
    expect(result.dropped).toBe(0);
  });
});
