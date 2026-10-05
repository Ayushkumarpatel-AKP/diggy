import { describe, expect, it } from 'vitest';
import { TOOL_NAMES, buildToolset } from '../src/index';
import { createMockContext } from './fakes';

describe('buildToolset', () => {
  it('contains every ToolName from @diggy/shared', () => {
    const tools = buildToolset(createMockContext());
    for (const name of TOOL_NAMES) {
      expect(tools[name]).toBeDefined();
    }
    expect(Object.keys(tools).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('exposes a description and a zod parameters schema for each tool', () => {
    const tools = buildToolset(createMockContext());
    for (const name of TOOL_NAMES) {
      const tool = tools[name]!;
      expect(typeof tool.description).toBe('string');
      expect(tool.parameters).toBeDefined();
    }
  });

  it('delegates execute() to the injected ToolContext', async () => {
    const context = createMockContext();
    const tools = buildToolset(context);

    await tools.readPage.execute!({ includeFields: true }, { toolCallId: 't1', messages: [] });
    expect(context.readPage).toHaveBeenCalledTimes(1);
    expect(context.readPage).toHaveBeenCalledWith({ includeFields: true });

    await tools.createReminder.execute!(
      { title: 'Standup', dueAt: '2025-06-01T09:00:00.000Z' },
      { toolCallId: 't2', messages: [] },
    );
    expect(context.createReminder).toHaveBeenCalledWith({
      title: 'Standup',
      dueAt: '2025-06-01T09:00:00.000Z',
    });

    await tools.setMood.execute!({ mood: 'happy' }, { toolCallId: 't3', messages: [] });
    expect(context.setMood).toHaveBeenCalledWith({ mood: 'happy' });
  });
});
