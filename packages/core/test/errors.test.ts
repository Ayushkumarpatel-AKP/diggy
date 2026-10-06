import { describe, expect, it } from 'vitest';
import { errorDetail, friendlyError } from '../src/errors.js';

const GROQ_429 =
  'groq stream request failed (429 ): {"error":{"message":"Rate limit reached for model `openai/gpt-oss-120b` in organization `org_01m3gzdjjmev28hhatn`","type":"tokens"}}';

describe('friendlyError', () => {
  it('turns a raw 429 payload into a short, readable line', () => {
    const message = friendlyError(GROQ_429);
    expect(message).toContain('⏳');
    expect(message.length).toBeLessThan(140);
    // none of the provider payload leaks through
    expect(message).not.toContain('{');
    expect(message).not.toContain('org_');
    expect(message).not.toContain('429');
  });

  it('mentions the fallback only when one was attempted', () => {
    expect(friendlyError(GROQ_429, { switched: true })).toMatch(/dono brain/i);
    expect(friendlyError(GROQ_429, { switched: false })).not.toMatch(/dono brain/i);
  });

  it('recognises the other failure shapes', () => {
    expect(friendlyError('401 Unauthorized: invalid api key')).toContain('🔑');
    expect(friendlyError('404 model not found')).toContain('🤖');
    expect(friendlyError('TypeError: fetch failed')).toContain('🌐');
    expect(friendlyError('503 Service Unavailable')).toContain('😴');
    expect(friendlyError(new Error('weird thing'))).toContain('😅');
  });

  it('never echoes a JSON body', () => {
    for (const input of [GROQ_429, '{"error":{"message":"x"}}', 'Internal Server Error']) {
      const message = friendlyError(input);
      expect(message).not.toMatch(/[{}\[\]]/);
    }
  });

  it('keeps the raw text available for logs, truncated', () => {
    expect(errorDetail(GROQ_429)).toContain('Rate limit reached');
    expect(errorDetail('x'.repeat(500)).length).toBeLessThanOrEqual(201);
  });
});
