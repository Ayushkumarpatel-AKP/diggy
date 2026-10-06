import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, currentTimeContext } from '../src/prompt.js';

describe('currentTimeContext', () => {
  it('states the local time, the offset and the UTC instant', () => {
    const now = new Date('2026-10-06T17:30:00+05:30');
    const text = currentTimeContext(now);
    expect(text).toContain('2026-10-06T17:30');
    expect(text).toContain('UTC+05:30');
    expect(text).toContain(now.toISOString());
  });

  it('renders the machine offset in a stable form', () => {
    const now = new Date('2026-10-06T10:00:00-08:00');
    const text = currentTimeContext(now);
    expect(text).toMatch(/UTC[+-]\d{2}:\d{2}/);
    // The local wall-clock comes from the same instant, whatever the machine zone.
    const pad = (v: number) => String(v).padStart(2, '0');
    const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    expect(text).toContain(local);
  });

  it('warns the model never to set a past reminder', () => {
    const text = currentTimeContext(new Date('2026-10-06T17:30:00+05:30'));
    expect(text.toLowerCase()).toContain('never set a reminder in the past');
  });

  it('is part of the system prompt (so reminders resolve against "now")', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('# Right now');
    expect(prompt).toContain('Local time:');
  });

  it('still appends host context', () => {
    const prompt = buildSystemPrompt('host extra');
    expect(prompt).toContain('# Right now');
    expect(prompt).toContain('# Context');
    expect(prompt).toContain('host extra');
  });
});
