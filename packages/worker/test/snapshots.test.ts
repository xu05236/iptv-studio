import { describe, expect, it } from 'vitest';
import { dirsToPrune } from '../src/lib/snapshots.js';

describe('snapshot directory pruning', () => {
  it('keeps the manifest ids and returns everything else', () => {
    const keep = new Set(['s3', 's2', 's1']);
    expect(dirsToPrune(['s4', 's3', 's2', 's1', 's0'], keep)).toEqual(['s4', 's0']);
  });

  it('returns nothing when every directory is still referenced', () => {
    expect(dirsToPrune(['a', 'b'], new Set(['a', 'b']))).toEqual([]);
  });
});
