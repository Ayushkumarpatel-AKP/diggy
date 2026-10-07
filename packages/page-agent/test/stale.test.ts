/**
 * Stale-ref tests: acting on a ref whose element is gone or replaced must fail
 * with a "take a new snapshot" error and must not touch the page.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPageAgent } from '../src/index';
import type { PageAgent } from '../src/index';
import { refFor, setBody } from './helpers';

describe('stale refs', () => {
  let agent: PageAgent;

  beforeEach(() => {
    document.body.innerHTML = '';
    agent = createPageAgent({ hooks: { navigate: vi.fn(), goBack: vi.fn(), scrollBy: vi.fn() } });
  });

  it('errors when the element is gone, and touches nothing', async () => {
    setBody(`<button type="button" id="old">Old</button>`);
    const ref = refFor(agent.snapshot(), 'Old');

    // The page re-rendered; the old button is detached.
    setBody(`<button type="button" id="new">New</button>`);
    const onClick = vi.fn();
    document.getElementById('new')?.addEventListener('click', onClick);

    const result = await agent.click(ref);

    expect(result.ok).toBe(false);
    expect(result.decision).toBe('deny');
    expect(result.error ?? '').toMatch(/snapshot/i);
    expect(result.error ?? '').toMatch(/stale/i);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('errors when a newer snapshot has re-stamped the element (replaced)', async () => {
    setBody(`<button type="button" id="persist">Persist</button>`);
    const first = refFor(agent.snapshot(), 'Persist');

    // A second snapshot hands out a new ref for the same element.
    agent.snapshot();

    const result = await agent.click(first);
    expect(result.ok).toBe(false);
    expect(result.error ?? '').toMatch(/snapshot/i);
  });

  it('errors for a ref that was never handed out', async () => {
    const result = await agent.click(987654);
    expect(result.ok).toBe(false);
    expect(result.decision).toBe('deny');
    expect(result.error ?? '').toMatch(/snapshot/i);
  });

  it('errors the same way for type and select', async () => {
    setBody(
      `<label for="t">Text field</label><input id="t" type="text">` +
        `<label for="s">Choice</label><select id="s"><option value="a">A</option></select>`,
    );
    const snap = agent.snapshot();
    const inputRef = refFor(snap, 'Text field');
    const selectRef = refFor(snap, 'Choice');

    setBody(`<p>gone</p>`);
    const typed = await agent.type(inputRef, 'x');
    const selected = await agent.select(selectRef, 'a');
    expect(typed.ok).toBe(false);
    expect(selected.ok).toBe(false);
    expect(typed.error ?? '').toMatch(/snapshot/i);
    expect(selected.error ?? '').toMatch(/snapshot/i);
  });
});
