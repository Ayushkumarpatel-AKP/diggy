import { describe, expect, it } from 'vitest';
import { runAgent, runAgentToText, toCoreMessages } from '../src/index';
import { createMockContext, createScriptedModel } from './fakes';

describe('runAgentToText (non-streaming, tool-calling loop)', () => {
  it('parses a model tool call and dispatches it to the injected ToolContext', async () => {
    const context = createMockContext();
    const model = createScriptedModel([
      {
        toolCalls: [
          {
            toolCallId: 'call_1',
            toolName: 'createReminder',
            args: { title: 'Standup', dueAt: '2025-06-01T09:00:00.000Z' },
          },
        ],
      },
      { text: 'Reminder set ho gaya! ✅' },
    ]);

    const result = await runAgentToText({
      messages: [{ role: 'user', content: 'kal 9 baje standup ka reminder laga do' }],
      provider: model,
      context,
      maxSteps: 3,
    });

    expect(context.createReminder).toHaveBeenCalledTimes(1);
    expect(context.createReminder).toHaveBeenCalledWith({
      title: 'Standup',
      dueAt: '2025-06-01T09:00:00.000Z',
    });
    expect(model.calls.length).toBe(2);
    expect(result.text).toBe('Reminder set ho gaya! ✅');
    // The tool call happened in step 1; the final step is the text answer.
    expect(result.steps[0]?.toolCalls[0]?.toolName).toBe('createReminder');
    expect(result.steps[0]?.toolResults).toHaveLength(1);
  });

  it('validates tool arguments against the zod schema before executing', async () => {
    const context = createMockContext();
    const model = createScriptedModel([
      {
        toolCalls: [
          {
            toolCallId: 'call_bad',
            toolName: 'setMood',
            args: { mood: 'not-a-mood' },
          },
        ],
      },
    ]);

    await expect(
      runAgentToText({
        messages: [{ role: 'user', content: 'set mood' }],
        provider: model,
        context,
        maxSteps: 1,
      }),
    ).rejects.toThrow();
    expect(context.setMood).not.toHaveBeenCalled();
  });
});

describe('runAgent (streaming, tool-calling loop)', () => {
  it('streams text and dispatches tool calls', async () => {
    const context = createMockContext();
    const model = createScriptedModel([
      {
        toolCalls: [{ toolCallId: 'call_2', toolName: 'setMood', args: { mood: 'happy' } }],
      },
      { text: 'Namaste! 🙏' },
    ]);

    const result = runAgent({
      messages: [{ role: 'user', content: 'hi diggy' }],
      provider: model,
      context,
      maxSteps: 3,
    });

    let text = '';
    for await (const delta of result.textStream) {
      text += delta;
    }

    expect(text).toBe('Namaste! 🙏');
    expect(context.setMood).toHaveBeenCalledWith({ mood: 'happy' });
  });
});

describe('toCoreMessages', () => {
  it('maps shared chat history into AI SDK core messages', () => {
    const messages = toCoreMessages([
      { id: '1', role: 'user', content: 'hello', createdAt: '2025-01-01T00:00:00.000Z' },
      {
        id: '2',
        role: 'assistant',
        content: 'hi',
        createdAt: '2025-01-01T00:00:01.000Z',
      },
      {
        id: '3',
        role: 'tool',
        content: 'done',
        toolName: 'notify',
        createdAt: '2025-01-01T00:00:02.000Z',
      },
    ]);

    expect(messages[0]).toEqual({ role: 'user', content: 'hello' });
    expect(messages[1]).toEqual({ role: 'assistant', content: 'hi' });
    expect(messages[2]?.role).toBe('user');
  });
});
