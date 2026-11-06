import { describe, expect, it } from 'vitest';
import { BUCKET_COUNT, bucketOf } from '../src/util/hash.js';

describe('bucketOf', () => {
  it('defaults to the shared 8-bucket layout the runner writes', () => {
    expect(BUCKET_COUNT).toBe(8);
    for (const id of ['cctv1', 'cctv2', 'hunan', 'x-abc123']) {
      expect(bucketOf(id)).toBe(bucketOf(id, BUCKET_COUNT));
      expect(bucketOf(id)).toBeGreaterThanOrEqual(0);
      expect(bucketOf(id)).toBeLessThan(BUCKET_COUNT);
    }
  });

  it('keeps legacy bucket counts addressable for the migration fallback', () => {
    expect(bucketOf('cctv1', 64)).toBeGreaterThanOrEqual(0);
    expect(bucketOf('cctv1', 64)).toBeLessThan(64);
  });
});
