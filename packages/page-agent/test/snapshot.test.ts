/**
 * Snapshot tests — the "eyes". jsdom, no browser.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearVaultValues, registerVaultValue } from '@diggy/policy';
import { createPageAgent, MAX_SNAPSHOT_ENTRIES, REDACTED_VALUE } from '../src/index';
import type { PageSnapshot } from '../src/index';
import { byName, refFor, setBody, stubRect } from './helpers';

function names(snap: PageSnapshot): string[] {
  return snap.entries.map((entry) => entry.name);
}

describe('snapshot', () => {
  let agent = createPageAgent();

  beforeEach(() => {
    document.body.innerHTML = '';
    agent = createPageAgent();
  });

  afterEach(() => {
    clearVaultValues();
  });

  it('finds a labelled button and a labelled input, with role/type/value', () => {
    setBody(
      `<label for="email">Email address</label>` +
        `<input id="email" type="email" value="a@b.com">` +
        `<button id="go" type="button">Sign in</button>`,
    );

    const snap = agent.snapshot();

    const email = byName(snap, 'Email address');
    expect(email?.role).toBe('textbox');
    expect(email?.type).toBe('email');
    expect(email?.value).toBe('a@b.com');

    const button = byName(snap, 'Sign in');
    expect(button?.role).toBe('button');
    expect(button?.bbox).toEqual({ x: 0, y: 0, width: 0, height: 0 });

    expect(snap.entries.length).toBe(2);
    expect(snap.total).toBe(2);
    expect(snap.truncated).toBe(false);
  });

  it('gives each entry an incrementing numeric ref', () => {
    setBody(`<button type="button">A</button><button type="button">B</button><button type="button">C</button>`);
    const snap = agent.snapshot();
    const refs = snap.entries.map((entry) => entry.ref);
    expect(refs).toEqual([...refs].sort((a, b) => a - b));
    expect(new Set(refs).size).toBe(refs.length);
  });

  it('redacts a password input value and never leaks it', () => {
    setBody(`<input id="pw" type="password" value="hunter2-SECRET">`);
    const snap = agent.snapshot();

    expect(snap.entries[0]?.value).toBe(REDACTED_VALUE);
    expect(JSON.stringify(snap)).not.toContain('hunter2-SECRET');
  });

  it('redacts a vault-marked field value', () => {
    setBody(`<input id="token" data-diggy-vault="true" value="vault-TOKEN-xyz">`);
    const snap = agent.snapshot();

    expect(snap.entries[0]?.value).toBe(REDACTED_VALUE);
    expect(JSON.stringify(snap)).not.toContain('vault-TOKEN-xyz');
  });

  it('redacts a value that matches a registered vault value', () => {
    registerVaultValue('REGISTERED-SECRET-42');
    setBody(`<input id="s" type="text" value="REGISTERED-SECRET-42">`);
    const snap = agent.snapshot();

    expect(snap.entries[0]?.value).toBe(REDACTED_VALUE);
    expect(JSON.stringify(snap)).not.toContain('REGISTERED-SECRET-42');
  });

  it('excludes a non-interactive div', () => {
    setBody(`<div id="plain">Just some layout text</div><button type="button">Go</button>`);
    const snap = agent.snapshot();

    expect(names(snap)).toEqual(['Go']);
    expect(JSON.stringify(snap)).not.toContain('Just some layout text');
  });

  it('excludes a hidden or disabled control', () => {
    setBody(
      `<button type="button" hidden>Hidden</button>` +
        `<button type="button" disabled>Disabled</button>` +
        `<div style="display:none"><button type="button">Inside Hidden</button></div>` +
        `<button type="button">Visible</button>`,
    );
    const snap = agent.snapshot();

    expect(names(snap)).toEqual(['Visible']);
  });

  it('includes elements inside an open shadow root', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById('host');
    const root = host?.attachShadow({ mode: 'open' });
    if (root) root.innerHTML = '<button type="button" id="shadow">Shadow Button</button>';

    const snap = agent.snapshot();
    expect(names(snap)).toContain('Shadow Button');
    expect(byName(snap, 'Shadow Button')?.role).toBe('button');
  });

  it('includes elements inside a same-origin iframe', () => {
    document.body.innerHTML = '<iframe id="frame"></iframe>';
    const frame = document.getElementById('frame') as HTMLIFrameElement;
    if (frame.contentDocument) {
      frame.contentDocument.body.innerHTML = '<button type="button" id="inner">Frame Button</button>';
    }

    const snap = agent.snapshot();
    expect(names(snap)).toContain('Frame Button');
  });

  it('caps the list, keeping on-screen elements before off-screen ones', () => {
    document.body.innerHTML = Array.from(
      { length: 5 },
      (_unused, index) => `<button type="button" id="b${index}">Button ${index}</button>`,
    ).join('');

    // 0 and 1 are on screen; 2, 3 and 4 are far below the fold.
    stubRect(document.getElementById('b0') as Element, { x: 0, y: 0, width: 100, height: 20 });
    stubRect(document.getElementById('b1') as Element, { x: 0, y: 40, width: 100, height: 20 });
    for (const id of ['b2', 'b3', 'b4']) {
      stubRect(document.getElementById(id) as Element, { x: 0, y: 5000, width: 100, height: 20 });
    }

    const snap = agent.snapshot({ max: 2, viewport: { width: 1024, height: 768 } });

    expect(snap.total).toBe(5);
    expect(snap.truncated).toBe(true);
    expect(snap.entries.length).toBe(2);
    expect(snap.entries.every((entry) => entry.inViewport)).toBe(true);
    expect(names(snap)).toEqual(['Button 0', 'Button 1']);
    expect(snap.droppedOffscreen).toBe(3);
  });

  it('defaults to a hard cap of MAX_SNAPSHOT_ENTRIES', () => {
    document.body.innerHTML = Array.from(
      { length: MAX_SNAPSHOT_ENTRIES + 20 },
      (_unused, index) => `<button type="button">B${index}</button>`,
    ).join('');

    const snap = agent.snapshot();
    expect(snap.total).toBe(MAX_SNAPSHOT_ENTRIES + 20);
    expect(snap.entries.length).toBe(MAX_SNAPSHOT_ENTRIES);
    expect(snap.truncated).toBe(true);
  });

  it('marks an on-screen element as inViewport and an off-screen one as not', () => {
    setBody(`<button type="button" id="on">On</button><button type="button" id="off">Off</button>`);
    stubRect(document.getElementById('on') as Element, { x: 0, y: 0, width: 100, height: 20 });
    stubRect(document.getElementById('off') as Element, { x: 0, y: 5000, width: 100, height: 20 });

    const snap = agent.snapshot({ viewport: { width: 1024, height: 768 } });
    expect(byName(snap, 'On')?.inViewport).toBe(true);
    expect(byName(snap, 'Off')?.inViewport).toBe(false);
    expect(refFor(snap, 'On')).toBeGreaterThan(0);
  });
});
