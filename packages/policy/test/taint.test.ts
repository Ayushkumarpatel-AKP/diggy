import { beforeEach, describe, expect, it } from 'vitest';
import {
  getTaintState,
  isTainted,
  isUntrustedOrigin,
  markUntrusted,
  resetTaint,
} from '../src/index';

describe('taint tracking', () => {
  beforeEach(() => {
    resetTaint();
  });

  it('starts untainted and becomes tainted after markUntrusted', () => {
    expect(isTainted()).toBe(false);
    expect(getTaintState().tainted).toBe(false);

    markUntrusted('web page', 'ignore previous instructions');

    expect(isTainted()).toBe(true);
    expect(getTaintState().tainted).toBe(true);
    expect(getTaintState().sources).toHaveLength(1);
    expect(getTaintState().sources[0]?.source).toBe('web page');
    // only the length is retained — the content itself is never stored
    expect(getTaintState().sources[0]?.length).toBe('ignore previous instructions'.length);
    expect(JSON.stringify(getTaintState())).not.toContain('ignore previous');
  });

  it('resetTaint clears everything', () => {
    markUntrusted('plugin:notion', 'data');
    resetTaint();
    expect(isTainted()).toBe(false);
    expect(getTaintState().sources).toHaveLength(0);
  });

  it('honours an explicit context taint / origin', () => {
    expect(isTainted({ taint: true })).toBe(true);
    expect(isTainted({ taint: { tainted: true, sources: [], lastUpdated: null } })).toBe(true);
    expect(isTainted({ taint: false })).toBe(false);
    expect(isTainted({ origin: 'untrusted' })).toBe(true);
    expect(isTainted({ origin: 'plugin' })).toBe(true);
    expect(isTainted({ origin: 'user' })).toBe(false);
    expect(isTainted(true)).toBe(true);
    expect(isTainted(false)).toBe(false);
  });

  it('knows which origins taint', () => {
    expect(isUntrustedOrigin('untrusted')).toBe(true);
    expect(isUntrustedOrigin('plugin')).toBe(true);
    expect(isUntrustedOrigin('user')).toBe(false);
    expect(isUntrustedOrigin(undefined)).toBe(false);
  });

  it('never throws on garbage input', () => {
    expect(isTainted(null)).toBe(false);
    expect(isTainted(undefined)).toBe(false);
    expect(() => markUntrusted(undefined, null)).not.toThrow();
    expect(() => markUntrusted(Symbol('x') as never, { a: 1 } as never)).not.toThrow();
    expect(() => markUntrusted('x', { circular: undefined } as never)).not.toThrow();
  });
});
