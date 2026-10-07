import { describe, expect, it } from 'vitest';
import {
  CORE_TOOL_NAMES,
  TOOL_CLASSIFICATION,
  classifyTool,
  isKnownTool,
  isOutwardEffect,
  normalizeToolName,
} from '../src/index';

const READ = ['readPage', 'getProfile', 'listReminders', 'crawl', 'searchWeb', 'readInbox', 'readCalendar'];
const WRITE = ['fillForm', 'createReminder', 'notify', 'speak', 'setMood', 'playAnim', 'pluginWrite'];
const IRREVERSIBLE = ['send', 'sendEmail', 'sendMessage', 'submit', 'submitForm', 'delete', 'purchase', 'pay', 'transfer', 'post', 'comment'];

describe('classifyTool', () => {
  it('classifies every real @diggy/core tool (no unknown)', () => {
    for (const name of CORE_TOOL_NAMES) {
      const cls = classifyTool(name, {});
      expect(cls, `${name} should be classified`).not.toBe('unknown');
      expect(isKnownTool(name)).toBe(true);
    }
    // exact set — the registry really has 13 tools
    expect(CORE_TOOL_NAMES).toHaveLength(13);
  });

  it('maps reads, writes and irreversible verbs to the right class', () => {
    for (const name of READ) expect(classifyTool(name), name).toBe('read');
    for (const name of WRITE) expect(classifyTool(name), name).toBe('write');
    for (const name of IRREVERSIBLE) expect(classifyTool(name), name).toBe('irreversible');
  });

  it('has an exhaustive table (every PolicyToolName has a class)', () => {
    for (const [name, cls] of Object.entries(TOOL_CLASSIFICATION)) {
      expect(['read', 'write', 'irreversible'], name).toContain(cls);
    }
    expect(Object.keys(TOOL_CLASSIFICATION).length).toBeGreaterThanOrEqual(26);
  });

  it('upgrades fillForm/submitForm to irreversible when submit:true', () => {
    expect(classifyTool('fillForm', { fields: [], submit: false })).toBe('write');
    expect(classifyTool('fillForm', { fields: [] })).toBe('write');
    expect(classifyTool('fillForm', { fields: [], submit: true })).toBe('irreversible');
    expect(classifyTool('submitForm', { submit: true })).toBe('irreversible');
  });

  it('returns unknown for anything not in the registry (never a default)', () => {
    expect(classifyTool('frobnicate')).toBe('unknown');
    expect(classifyTool('')).toBe('unknown');
    expect(classifyTool(undefined)).toBe('unknown');
    expect(classifyTool(null)).toBe('unknown');
    expect(classifyTool({})).toBe('unknown');
    expect(classifyTool('READPAGE')).toBe('unknown');
    expect(isKnownTool('rm -rf /')).toBe(false);
  });

  it('isOutwardEffect treats write/irreversible/unknown as outward, read as not', () => {
    expect(isOutwardEffect('read')).toBe(false);
    expect(isOutwardEffect('write')).toBe(true);
    expect(isOutwardEffect('irreversible')).toBe(true);
    expect(isOutwardEffect('unknown')).toBe(true);
  });

  it('normalizes tool names without throwing on garbage', () => {
    expect(normalizeToolName('  readPage ')).toBe('readPage');
    expect(normalizeToolName(42)).toBe('42');
    expect(normalizeToolName({})).toBe('');
    expect(normalizeToolName(Symbol('x'))).toBe('');
  });
});
