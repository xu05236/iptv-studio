import { describe, expect, it } from 'vitest';
import { countCnCandidates } from '../src/state/cnProbeStats.js';
import type { LineEntry } from '../src/types.js';

const NOW = Date.parse('2026-11-23T00:00:00Z');

function line(partial: Partial<LineEntry> & { url: string; sourceId: string }): LineEntry {
  return { key: `${partial.sourceId}:${partial.url}`, urlKey: partial.url, channelId: 'cctv1', name: 'CCTV-1', ...partial } as LineEntry;
}

describe('countCnCandidates', () => {
  it('counts dead and suspect lines that were not reachable via a domestic proxy', () => {
    const lines = [
      line({ url: 'http://a.example/1.m3u8', sourceId: 's1', status: 'dead' }),
      line({ url: 'http://a.example/2.m3u8', sourceId: 's1', status: 'suspect' }),
      line({ url: 'http://a.example/3.m3u8', sourceId: 's1', status: 'alive' }),
      line({ url: 'http://a.example/4.m3u8', sourceId: 's1', status: 'dead', cnReachable: true }),
    ];
    expect(countCnCandidates(lines, NOW)).toEqual({ eligible: 2, outstanding: 2 });
  });

  it('keeps recently checked lines in outstanding but out of eligible', () => {
    const fresh = new Date(NOW - 3_600_000).toISOString();
    const stale = new Date(NOW - 25 * 3_600_000).toISOString();
    const lines = [
      line({ url: 'http://b.example/1.m3u8', sourceId: 's1', status: 'dead', cnCheckedAt: fresh }),
      line({ url: 'http://b.example/2.m3u8', sourceId: 's1', status: 'dead', cnCheckedAt: stale }),
    ];
    expect(countCnCandidates(lines, NOW)).toEqual({ eligible: 1, outstanding: 2 });
  });

  it('dedupes the same URL + headers across sources', () => {
    const lines = [
      line({ url: 'http://c.example/live.m3u8', sourceId: 's1', status: 'dead' }),
      line({ url: 'http://c.example/live.m3u8', sourceId: 's2', status: 'dead' }),
      line({ url: 'http://c.example/live.m3u8?token=1', sourceId: 's2', status: 'dead' }),
    ];
    expect(countCnCandidates(lines, NOW)).toEqual({ eligible: 2, outstanding: 2 });
  });
});
