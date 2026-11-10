import { describe, expect, it } from 'vitest';
import { lineSignature, pickDuplicateOwner } from '../src/state/lineSignature.js';

describe('lineSignature', () => {
  it('keeps header order irrelevant but header values meaningful', () => {
    const a = lineSignature({ urlKey: 'http://a/1.m3u8', headers: { 'User-Agent': 'x', Referer: 'a' } });
    const b = lineSignature({ urlKey: 'http://a/1.m3u8', headers: { Referer: 'a', 'User-Agent': 'x' } });
    const c = lineSignature({ urlKey: 'http://a/1.m3u8', headers: { Referer: 'b' } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('pickDuplicateOwner', () => {
  it('prefers the earliest healthy line', () => {
    const owner = pickDuplicateOwner([
      { key: 'late', status: 'alive', firstSeenAt: '2026-11-02T00:00:00Z' },
      { key: 'early', status: 'alive', firstSeenAt: '2026-11-01T00:00:00Z' },
    ]);
    expect(owner?.key).toBe('early');
  });

  it('falls back to a dead line when no healthy copy exists', () => {
    const owner = pickDuplicateOwner([{ key: 'dead', status: 'dead', firstSeenAt: '2026-11-01T00:00:00Z' }]);
    expect(owner?.key).toBe('dead');
  });
});
