import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings, type LineEntry } from '@iptv/core';
import { planProbes } from '../src/pipeline/probe.js';
import type { SourceRecord } from '../src/store.js';

function line(sourceId: string, index: number): LineEntry {
  const url = `http://${sourceId}.example/live/${index}.m3u8`;
  return {
    key: `${sourceId}-${index}`,
    sourceId,
    channelId: `ch-${sourceId}-${index}`,
    name: `channel-${index}`,
    url,
    urlKey: `/${index}`,
    protocol: 'hls',
    status: 'unknown',
    failCount: 0,
    score: 0,
    firstSeenAt: '2026-10-01T00:00:00Z',
    lastSeenAt: '2026-10-01T00:00:00Z',
    tags: [],
  };
}

function sourcesOf(ids: string[]): Map<string, SourceRecord> {
  return new Map(
    ids.map((id) => [id, { id, tier: 'normal', reputation: 50 } as unknown as SourceRecord]),
  );
}

const settings: AppSettings = { ...DEFAULT_SETTINGS, probePerChannel: 24, probeAliveHours: 360, probePremiumHours: 168 };

describe('planProbes fair share', () => {
  it('gives each source an equal share of a small budget', () => {
    const lines = [
      ...Array.from({ length: 40 }, (_, index) => line('a', index)),
      ...Array.from({ length: 40 }, (_, index) => line('b', index)),
      ...Array.from({ length: 40 }, (_, index) => line('c', index)),
    ];
    const planned = planProbes(lines, sourcesOf(['a', 'b', 'c']), settings, 30, new Date('2026-10-30T00:00:00Z'), false);
    const counts = new Map<string, number>();
    for (const item of planned) counts.set(item.sourceId, (counts.get(item.sourceId) ?? 0) + 1);
    expect(planned).toHaveLength(30);
    expect([...counts.values()]).toEqual([10, 10, 10]);
  });

  it('redistributes the unused share of a small source', () => {
    const lines = [
      ...Array.from({ length: 4 }, (_, index) => line('a', index)),
      ...Array.from({ length: 40 }, (_, index) => line('b', index)),
      ...Array.from({ length: 40 }, (_, index) => line('c', index)),
    ];
    const planned = planProbes(lines, sourcesOf(['a', 'b', 'c']), settings, 30, new Date('2026-10-30T00:00:00Z'), false);
    const counts = new Map<string, number>();
    for (const item of planned) counts.set(item.sourceId, (counts.get(item.sourceId) ?? 0) + 1);
    expect(planned).toHaveLength(30);
    expect(counts.get('a')).toBe(4);
    expect(counts.get('b')).toBe(13);
    expect(counts.get('c')).toBe(13);
  });
});
