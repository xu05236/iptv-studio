import { describe, expect, it } from 'vitest';
import type { LineEntry } from '@iptv/core';
import { selectCnProbeLines } from '../src/pipeline/cnProbeSelection.js';

function line(partial: Partial<LineEntry> & { sourceId: string; url: string }): LineEntry {
  return {
    key: `${partial.sourceId}:${partial.url}`,
    channelId: 'cctv1',
    name: 'CCTV-1',
    urlKey: partial.url,
    status: 'dead',
    failCount: 1,
    ...partial,
  } as LineEntry;
}

const NOW = Date.parse('2026-11-26T10:00:00Z');

describe('selectCnProbeLines', () => {
  it('prefers dead over suspect and fresh failures over stale ones', () => {
    const picked = selectCnProbeLines(
      [
        line({ sourceId: 'a', url: 'http://a.example/old', status: 'dead', lastProbeAt: '2026-11-20T00:00:00Z' }),
        line({ sourceId: 'a', url: 'http://a.example/new', status: 'dead', lastProbeAt: '2026-11-26T09:00:00Z' }),
        line({ sourceId: 'a', url: 'http://a.example/suspect', status: 'suspect', lastProbeAt: '2026-11-26T09:30:00Z' }),
      ],
      { limit: 10, now: NOW },
    );
    expect(picked[0].url).toBe('http://a.example/new');
    expect(picked[1].url).toBe('http://a.example/old');
    expect(picked[2].url).toBe('http://a.example/suspect');
  });

  it('caps one source per batch so other sources get picked', () => {
    const lines: LineEntry[] = [];
    for (let i = 0; i < 100; i += 1) lines.push(line({ sourceId: 'big', url: `http://big.example/${i}` }));
    for (let i = 0; i < 100; i += 1) lines.push(line({ sourceId: 'small', url: `http://small.example/${i}` }));
    const picked = selectCnProbeLines(lines, { limit: 24, perSourceCap: 8, now: NOW });
    expect(picked).toHaveLength(24);
    expect(picked.filter((item) => item.sourceId === 'big')).toHaveLength(12);
    expect(picked.filter((item) => item.sourceId === 'small')).toHaveLength(12);
  });

  it('fills the batch when there are fewer sources than the cap allows', () => {
    const lines: LineEntry[] = [];
    for (let i = 0; i < 120; i += 1) lines.push(line({ sourceId: 'a', url: `http://a.example/${i}` }));
    for (let i = 0; i < 120; i += 1) lines.push(line({ sourceId: 'b', url: `http://b.example/${i}` }));
    const picked = selectCnProbeLines(lines, { limit: 200, perSourceCap: 50, now: NOW });
    expect(picked).toHaveLength(200);
  });

  it('deduplicates the same URL and headers across sources', () => {
    const picked = selectCnProbeLines(
      [
        line({ sourceId: 'a', url: 'http://same.example/live.m3u8', headers: { referer: 'x' } }),
        line({ sourceId: 'b', url: 'http://same.example/live.m3u8', headers: { referer: 'x' } }),
        line({ sourceId: 'c', url: 'http://same.example/live.m3u8', headers: { referer: 'y' } }),
      ],
      { limit: 10, now: NOW },
    );
    expect(picked).toHaveLength(2);
    expect(picked.map((item) => item.headers?.referer).sort()).toEqual(['x', 'y']);
  });

  it('skips recently checked lines, reachable lines and alive lines', () => {
    const picked = selectCnProbeLines(
      [
        line({ sourceId: 'a', url: 'http://a.example/cooling', cnCheckedAt: '2026-11-26T09:30:00Z' }),
        line({ sourceId: 'a', url: 'http://a.example/reachable', cnReachable: true }),
        line({ sourceId: 'a', url: 'http://a.example/alive', status: 'alive' }),
        line({ sourceId: 'a', url: 'http://a.example/dead' }),
      ],
      { limit: 10, now: NOW },
    );
    expect(picked.map((item) => item.url)).toEqual(['http://a.example/dead']);
  });
});
