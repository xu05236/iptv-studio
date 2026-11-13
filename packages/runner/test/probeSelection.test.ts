import { describe, expect, it } from 'vitest';
import { lineSignature, type LineEntry } from '@iptv/core';
import { MERGED_PROBE_PER_CHANNEL, selectProbeLines } from '../src/pipeline/probeSelection.js';

function line(channelId: string, key: string, sourceId = 'src-a'): LineEntry {
  return {
    key,
    sourceId,
    channelId,
    name: '频道',
    url: `http://example.com/${key}.m3u8`,
    urlKey: `example.com/${key}.m3u8`,
    protocol: 'hls',
    status: 'unknown',
    failCount: 0,
    score: 0,
    tags: [],
    sourceIds: [sourceId],
    firstSeenAt: '2026-01-01T00:00:00Z',
    lastSeenAt: '2026-01-01T00:00:00Z',
  } as LineEntry;
}

function options(overrides: Partial<Parameters<typeof selectProbeLines>[1]> = {}) {
  return {
    matches: () => true,
    channelIds: new Set(['a', 'b', 'c']),
    favorites: new Set<string>(),
    cooldown: new Map<string, number>(),
    takenSignatures: new Set<string>(),
    now: Date.parse('2026-11-13T00:00:00Z'),
    perChannel: 2,
    limit: 6,
    ...overrides,
  };
}

describe('selectProbeLines', () => {
  it('visits channels round-robin instead of filling from one channel', () => {
    const lines = [
      ...Array.from({ length: 5 }, (_, index) => line('a', `a-${index}`)),
      ...Array.from({ length: 5 }, (_, index) => line('b', `b-${index}`)),
      ...Array.from({ length: 5 }, (_, index) => line('c', `c-${index}`)),
    ];
    const picked = selectProbeLines(lines, options());
    expect(picked).toHaveLength(6);
    const counts = picked.reduce<Record<string, number>>((acc, item) => {
      acc[item.channelId] = (acc[item.channelId] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ a: 2, b: 2, c: 2 });
  });

  it('lets a merged channel use the larger allowance', () => {
    const lines = [
      ...Array.from({ length: 300 }, (_, index) => line('x-mc-1', `m-${index}`)),
      line('c', 'c-0'),
    ];
    const picked = selectProbeLines(lines, options({ channelIds: new Set(['x-mc-1', 'c']), limit: 500, perChannel: 24 }));
    expect(picked.filter((item) => item.channelId === 'x-mc-1')).toHaveLength(MERGED_PROBE_PER_CHANNEL);
    expect(picked).toHaveLength(MERGED_PROBE_PER_CHANNEL + 1);
  });

  it('skips URL signatures that are cooling down', () => {
    const a = line('a', 'a-0');
    const b = line('a', 'a-1');
    const cooldown = new Map<string, number>([[lineSignature(a), Date.parse('2026-11-14T00:00:00Z')]]);
    const picked = selectProbeLines([a, b], options({ cooldown, limit: 1 }));
    expect(picked.map((item) => item.key)).toEqual(['a-1']);
  });

  it('starts with favorite sources even when their channel is larger', () => {
    const lines = [
      line('a', 'a-0', 'src-a'),
      line('b', 'b-0', 'src-fav'),
    ];
    const picked = selectProbeLines(lines, options({ favorites: new Set(['src-fav']), limit: 2 }));
    expect(picked[0]!.sourceId).toBe('src-fav');
  });
});
