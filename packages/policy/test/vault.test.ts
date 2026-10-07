import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  VAULT_SENTINEL,
  VAULT_SENTINEL_PATTERN,
  clearVaultValues,
  containsVaultValue,
  isSensitiveKey,
  redactForModel,
  registerVaultValue,
  registerVaultValues,
  vaultValuesRegistered,
} from '../src/index';

const SECRET = 'SUPER-SECRET-PAN-ABCDE1234F';

describe('vault safety', () => {
  beforeEach(() => {
    clearVaultValues();
  });
  afterEach(() => {
    clearVaultValues();
  });

  it('SENTINEL TEST — a registered vault value never appears in a serialised model message', () => {
    registerVaultValue(SECRET);

    const modelMessage = {
      role: 'user',
      content: `Here are my details: PAN ${SECRET}, please use them.`,
      toolResult: { pan: SECRET },
    };

    const serialized = redactForModel(modelMessage);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain(VAULT_SENTINEL);
    expect(VAULT_SENTINEL_PATTERN.test(serialized)).toBe(true);
  });

  it('scrubs registered values out of raw strings too', () => {
    registerVaultValue(SECRET);
    const redacted = redactForModel(`my pan is ${SECRET}`);
    expect(redacted).not.toContain(SECRET);
    expect(redacted).toContain(VAULT_SENTINEL);
  });

  it('redacts values under sensitive keys even when never registered', () => {
    const redacted = redactForModel({
      name: 'Ayush',
      password: 'hunter2',
      identity: { pan: 'ABCDE1234F', dob: '1990-01-01' },
      bank: { account: '12345678' },
    });
    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('ABCDE1234F');
    expect(redacted).not.toContain('1990-01-01');
    expect(redacted).not.toContain('12345678');
    expect(redacted).toContain('[[VAULT_REDACTED:password]]');
    expect(redacted).toContain('[[VAULT_REDACTED:pan]]');
    // non-secret data survives
    expect(redacted).toContain('Ayush');
  });

  it('does not over-redact ordinary words that merely contain a hint', () => {
    expect(isSensitiveKey('company')).toBe(false); // contains "pan"
    expect(isSensitiveKey('shippingAddress')).toBe(false); // contains "pin"
    expect(isSensitiveKey('panel')).toBe(false);
    expect(isSensitiveKey('password')).toBe(true);
    expect(isSensitiveKey('apiKey')).toBe(true);
    expect(isSensitiveKey('panNumber')).toBe(true);
  });

  it('registerVaultValues + containsVaultValue round-trip', () => {
    registerVaultValues([SECRET, '', 'second-secret', 123 as never, null as never]);
    expect(vaultValuesRegistered()).toBe(2);
    expect(containsVaultValue(`prefix ${SECRET} suffix`)).toBe(true);
    expect(containsVaultValue('nothing here')).toBe(false);
  });

  it('never throws on garbage or cyclic input', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic['self'] = cyclic;
    expect(() => redactForModel(cyclic)).not.toThrow();
    expect(() => redactForModel(10n)).not.toThrow();
    expect(() => redactForModel(undefined)).not.toThrow();
    expect(() => redactForModel(Symbol('s'))).not.toThrow();
    expect(() => redactForModel(() => 1)).not.toThrow();
    expect(typeof redactForModel(undefined)).toBe('string');
  });
});
