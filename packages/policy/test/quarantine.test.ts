import { describe, expect, it } from 'vitest';
import {
  QUARANTINE_CALLER_OBLIGATION,
  summarizeUntrusted,
  UNTRUSTED_FENCE_BEGIN,
  UNTRUSTED_FENCE_END,
} from '../src/index';

describe('summarizeUntrusted (quarantined reader contract)', () => {
  it('fences the raw text and returns only the no-tools reader summary', async () => {
    let seen = '';
    const outcome = await summarizeUntrusted('raw signed-in page text', (fenced) => {
      seen = fenced;
      return 'a short summary';
    });

    expect(outcome.summary).toBe('a short summary');
    expect(outcome.label).toBe('untrusted content');
    expect(outcome.fenced).toContain(UNTRUSTED_FENCE_BEGIN);
    expect(outcome.fenced).toContain(UNTRUSTED_FENCE_END);
    expect(outcome.fenced).toContain('raw signed-in page text');
    // the reader sees exactly the fenced block that was returned
    expect(seen).toBe(outcome.fenced);
  });

  it('supports an async reader and a custom label', async () => {
    const outcome = await summarizeUntrusted(
      'inbox body',
      async (fenced) => (fenced.includes('inbox body') ? 'ok' : 'bad'),
      { label: 'gmail inbox' },
    );
    expect(outcome.summary).toBe('ok');
    expect(outcome.label).toBe('gmail inbox');
    expect(outcome.fenced).toContain('gmail inbox');
  });

  it('never throws synchronously on garbage text', async () => {
    await expect(summarizeUntrusted(undefined, () => 'fine')).resolves.toMatchObject({ summary: 'fine' });
    await expect(summarizeUntrusted(null, () => 0)).resolves.toMatchObject({ summary: 0 });
  });

  it('rejects clearly if the caller forgets to supply a reader', async () => {
    await expect(summarizeUntrusted('x', undefined as never)).rejects.toBeInstanceOf(TypeError);
  });

  it('documents the caller obligation', () => {
    expect(QUARANTINE_CALLER_OBLIGATION).toMatch(/no tools/i);
    expect(QUARANTINE_CALLER_OBLIGATION).toMatch(/summary/i);
  });
});
