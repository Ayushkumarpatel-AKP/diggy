/**
 * Happy-path tests for each action: every one returns `ok: true` with a summary
 * that describes the page change. jsdom, no browser.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPageAgent } from '../src/index';
import type { PageAgent } from '../src/index';
import { refFor, setBody } from './helpers';

describe('actions — happy paths', () => {
  let agent: PageAgent;
  let navigateSpy: ReturnType<typeof vi.fn>;
  let goBackSpy: ReturnType<typeof vi.fn>;
  let scrollSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    navigateSpy = vi.fn();
    goBackSpy = vi.fn();
    scrollSpy = vi.fn();
    agent = createPageAgent({
      hooks: { navigate: navigateSpy, goBack: goBackSpy, scrollBy: scrollSpy },
    });
  });

  it('click — clicks the element and describes it', async () => {
    setBody(`<button type="button" id="save">Save draft</button>`);
    const clicked = vi.fn();
    document.getElementById('save')?.addEventListener('click', clicked);

    const ref = refFor(agent.snapshot(), 'Save draft');
    const result = await agent.click(ref);

    expect(result.ok).toBe(true);
    expect(result.decision).toBe('allow');
    expect(result.summary).toContain('Clicked "Save draft"');
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('type — sets the value and never echoes the typed text', async () => {
    setBody(`<label for="nick">Nickname</label><input id="nick" type="text">`);
    const ref = refFor(agent.snapshot(), 'Nickname');

    const result = await agent.type(ref, 'diggy');

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('Typed 5 characters into "Nickname"');
    expect(result.summary).not.toContain('diggy');
    expect((document.getElementById('nick') as HTMLInputElement).value).toBe('diggy');
  });

  it('select — chooses an option by its label', async () => {
    setBody(
      `<label for="freq">Frequency</label>` +
        `<select id="freq"><option value="d">Daily</option><option value="w">Weekly</option></select>`,
    );
    const ref = refFor(agent.snapshot(), 'Frequency');

    const result = await agent.select(ref, 'Weekly');

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('Selected "Weekly"');
    expect((document.getElementById('freq') as HTMLSelectElement).value).toBe('w');
  });

  it('pressKey — sends a key to the focused element', async () => {
    setBody(`<label for="q">Query</label><input id="q" type="text">`);
    const field = document.getElementById('q') as HTMLInputElement;
    field.focus();

    const result = await agent.pressKey('Tab');

    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Pressed Tab on "Query".');
  });

  it('scroll — accepts a direction, an amount and both', async () => {
    const down = await agent.scroll('down');
    expect(down.ok).toBe(true);
    expect(down.summary).toBe('Scrolled down 400px.');
    expect(scrollSpy).toHaveBeenLastCalledWith(0, 400);

    const right = await agent.scroll({ direction: 'right', amount: 250 });
    expect(right.ok).toBe(true);
    expect(right.summary).toBe('Scrolled right 250px.');
    expect(scrollSpy).toHaveBeenLastCalledWith(250, 0);

    const amountOnly = await agent.scroll(120);
    expect(amountOnly.summary).toBe('Scrolled down 120px.');
  });

  it('waitFor — waits for text', async () => {
    setBody(`<p>Welcome back, friend</p>`);
    const result = await agent.waitFor({ text: 'Welcome back' });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('Welcome back');
    expect(result.summary).toContain('appeared after');
  });

  it('waitFor — waits for a selector', async () => {
    setBody(`<div id="ready">ready</div>`);
    const result = await agent.waitFor({ selector: '#ready' });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('Selector "#ready"');
    expect(result.summary).toContain('appeared after');
  });

  it('waitFor — waits a fixed time', async () => {
    const result = await agent.waitFor({ ms: 1 });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Waited 1ms.');
  });

  it('navigate — navigates through the injected router', async () => {
    const result = await agent.navigate('https://example.com/docs');
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Navigating to https://example.com/docs.');
    expect(navigateSpy).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('goBack — goes back through the injected router', async () => {
    const result = await agent.goBack();
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Went back to the previous page.');
    expect(goBackSpy).toHaveBeenCalledTimes(1);
  });
});
