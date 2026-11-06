import { describe, expect, it } from 'vitest';
import { computeParseDrop, PARSE_DROP_THRESHOLD } from '../src/source/parseReport.js';

describe('computeParseDrop', () => {
  it('ignores small baselines and growth', () => {
    expect(computeParseDrop(10, 4)).toBeNull();
    expect(computeParseDrop(100, 120)).toBeNull();
    expect(computeParseDrop(100, 100)).toBeNull();
    expect(computeParseDrop(null, 50)).toBeNull();
  });

  it('reports a meaningful drop', () => {
    expect(computeParseDrop(100, 40)).toBe(60);
    expect(computeParseDrop(100, 69)).toBe(31);
    expect(computeParseDrop(100, 71)).toBe(29);
    expect(PARSE_DROP_THRESHOLD).toBe(30);
  });
});
