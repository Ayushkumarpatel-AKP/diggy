import { describe, expect, it } from 'vitest';
import { ConversationBuffer, InMemoryNotesStore } from '../src/index';

describe('ConversationBuffer', () => {
  it('keeps a rolling window of the most recent messages', () => {
    const buffer = new ConversationBuffer({ maxMessages: 3 });
    for (let i = 1; i <= 5; i += 1) {
      buffer.addUser(`m${i}`);
    }
    expect(buffer.size).toBe(3);
    expect(buffer.messages()).toEqual([
      { role: 'user', content: 'm3' },
      { role: 'user', content: 'm4' },
      { role: 'user', content: 'm5' },
    ]);
  });

  it('enforces the character budget', () => {
    const buffer = new ConversationBuffer({ maxMessages: 100, maxChars: 10 });
    buffer.addUser('12345');
    buffer.addUser('67890');
    buffer.addUser('abcde');
    // 15 chars total; oldest dropped until <= 10, and never below one message.
    expect(buffer.size).toBe(2);
    expect(buffer.messages()).toEqual([
      { role: 'user', content: '67890' },
      { role: 'user', content: 'abcde' },
    ]);
  });

  it('prepends the system prompt in toPrompt()', () => {
    const buffer = new ConversationBuffer({ system: 'SYS' });
    buffer.addAssistant('hello');
    expect(buffer.toPrompt()).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('clears and resets', () => {
    const buffer = new ConversationBuffer({ system: 'SYS' });
    buffer.addUser('x');
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.getSystem()).toBe('SYS');
    buffer.reset();
    expect(buffer.getSystem()).toBeUndefined();
  });
});

describe('InMemoryNotesStore', () => {
  it('stores, reads, lists and deletes key/value notes', async () => {
    const store = new InMemoryNotesStore();
    await store.set('theme', 'dark');
    await store.set('city', 'Pune');

    expect(await store.get('theme')).toBe('dark');
    expect(await store.has('city')).toBe(true);
    expect((await store.keys()).sort()).toEqual(['city', 'theme']);
    expect((await store.entries()).map((e) => e.key).sort()).toEqual(['city', 'theme']);

    expect(await store.delete('theme')).toBe(true);
    expect(await store.get('theme')).toBeUndefined();
    expect(await store.delete('theme')).toBe(false);

    await store.clear();
    expect(await store.keys()).toEqual([]);
  });

  it('seeds from initial entries and serialises', () => {
    const store = new InMemoryNotesStore([
      { key: 'a', value: '1', updatedAt: '2025-01-01T00:00:00.000Z' },
    ]);
    expect(store.toJSON()).toEqual([
      { key: 'a', value: '1', updatedAt: '2025-01-01T00:00:00.000Z' },
    ]);
  });
});
