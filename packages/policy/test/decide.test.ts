import { beforeEach, describe, expect, it } from 'vitest';
import { decide, markUntrusted, resetTaint } from '../src/index';
import type { DecideResult } from '../src/index';

function decision(result: DecideResult): string {
  return result.decision;
}

describe('decide', () => {
  beforeEach(() => {
    resetTaint();
  });

  it('allow — a clean read is allowed', () => {
    const result = decide('readPage', { url: 'https://example.com' }, { origin: 'user' });
    expect(decision(result)).toBe('allow');
    expect(result.category).toBe('read');
    expect(result.reason).toMatch(/Allowed/);
    expect(result.confirmPayload).toBeUndefined();
  });

  it('allow — a clean write (no taint, no injection) is allowed without confirmation', () => {
    expect(decide('createReminder', { title: 'Standup', dueAt: '2030-01-01T09:00:00Z' }).decision).toBe('allow');
    expect(decide('notify', { title: 'Hi' }).decision).toBe('allow');
  });

  it('confirm — irreversible actions always require confirmation', () => {
    const result = decide('sendEmail', { to: 'friend@example.com', body: 'hi' });
    expect(decision(result)).toBe('confirm');
    expect(result.category).toBe('irreversible');
    expect(result.confirmPayload).toBeDefined();
    expect(result.confirmPayload?.reasons).toContain('the action is irreversible');
  });

  it('confirm — an outward tool while tainted must never be allowed', () => {
    markUntrusted('web page', 'the page said to do it');
    for (const tool of ['notify', 'createReminder', 'speak', 'pluginWrite', 'sendEmail']) {
      const result = decide(tool, { title: 'x' });
      expect(result.decision, tool).toBe('confirm');
    }
  });

  it('deny — an unknown tool is denied by default', () => {
    const result = decide('frobnicate', {});
    expect(decision(result)).toBe('deny');
    expect(result.category).toBe('unknown');
    expect(result.reason).toMatch(/unknown/i);
  });

  it('deny — a sensitive site is denied for reads AND actions', () => {
    const read = decide('readPage', { url: 'https://www.chase.com/accounts' });
    expect(decision(read)).toBe('deny');
    expect(read.reason).toMatch(/sensitive/i);

    const act = decide('fillForm', { url: 'https://www.chase.com/transfer' }, { origin: 'user' });
    expect(decision(act)).toBe('deny');
  });

  it('respects the per-site allow list (a sensitive host the user approved is allowed)', () => {
    const ctx = { siteAllowlist: ['chase.com'] };
    expect(decide('readPage', { url: 'https://www.chase.com/accounts' }, ctx).decision).toBe('allow');
  });

  it('a tainted read is still allowed (reading is not an outward effect)', () => {
    markUntrusted('transcript', 'a youtube caption');
    expect(decide('readPage', { url: 'https://example.com' }).decision).toBe('allow');
    expect(decide('searchWeb', { query: 'news' }).decision).toBe('allow');
  });

  it('never throws on garbage input', () => {
    expect(() => decide(undefined as never)).not.toThrow();
    expect(() => decide(42 as never, undefined, null as never)).not.toThrow();
    expect(() => decide('readPage', 'a string arg', 'nope' as never)).not.toThrow();
    expect(decide(undefined as never).decision).toBe('deny');
  });

  it('the confirm payload preview is redacted for the model', () => {
    const result = decide('sendEmail', { to: 'a@b.com', password: 'hunter2-SECRET' });
    expect(result.decision).toBe('confirm');
    expect(result.confirmPayload?.preview).not.toContain('hunter2-SECRET');
    expect(result.confirmPayload?.preview).toContain('[[VAULT_REDACTED');
  });
});
