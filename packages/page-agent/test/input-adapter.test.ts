/**
 * The trusted-input seam: the interface has a safe default that never reports
 * itself available, and a custom adapter is carried through untouched.
 */
import { describe, expect, it } from 'vitest';
import { createPageAgent, NullInputAdapter } from '../src/index';
import type { TrustedInputAdapter } from '../src/index';

describe('TrustedInputAdapter seam', () => {
  it('NullInputAdapter is always unavailable and its methods are inert', async () => {
    const adapter = new NullInputAdapter();
    expect(adapter.isAvailable()).toBe(false);
    await expect(adapter.moveTo(1, 2)).resolves.toBeUndefined();
    await expect(adapter.clickAt(1, 2)).resolves.toBeUndefined();
    await expect(adapter.sendKey('Enter')).resolves.toBeUndefined();
    await expect(adapter.typeText('hi')).resolves.toBeUndefined();
    await expect(adapter.scrollBy(0, 10)).resolves.toBeUndefined();
  });

  it('a page-agent defaults to NullInputAdapter and can carry a real one', () => {
    const defaultAgent = createPageAgent();
    expect(defaultAgent.input).toBeInstanceOf(NullInputAdapter);

    const spy: TrustedInputAdapter = {
      isAvailable: () => true,
      moveTo: async () => {},
      clickAt: async () => {},
      sendKey: async () => {},
      typeText: async () => {},
      scrollBy: async () => {},
    };
    const custom = createPageAgent({ input: spy });
    expect(custom.input).toBe(spy);
  });
});
