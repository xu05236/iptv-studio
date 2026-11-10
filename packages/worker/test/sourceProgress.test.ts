import { describe, expect, it } from 'vitest';
import { deltaOf, parseDelta } from '../src/lib/sourceProgress.js';

const before = { total: 100, alive: 40, pending: 50, quarantine: 5, rejected: 5 };

describe('source progress deltas', () => {
  it('returns null until there is a baseline', () => {
    expect(deltaOf(before, null)).toBeNull();
  });

  it('subtracts the previous probeable snapshot', () => {
    const current = { total: 90, alive: 30, pending: 52, quarantine: 4, rejected: 4 };
    expect(deltaOf(current, before)).toEqual({ total: -10, alive: -10, pending: 2, quarantine: -1, rejected: -1 });
  });

  it('parses a stored delta and ignores malformed payloads', () => {
    expect(parseDelta(JSON.stringify({ total: -3, alive: 1, pending: 0, quarantine: 0, rejected: 0 }))).toEqual({
      total: -3,
      alive: 1,
      pending: 0,
      quarantine: 0,
      rejected: 0,
    });
    expect(parseDelta('not-json')).toBeNull();
    expect(parseDelta('{}')).toBeNull();
  });
});
