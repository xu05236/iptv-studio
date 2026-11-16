import { describe, expect, it } from 'vitest';
import type { LineEntry } from '@iptv/core';
import { selectProbeLines } from '../src/pipeline/probeSelection.js';

function make(channelId: string, sourceId: string, index: number): LineEntry {
  const url = `http://${sourceId}.example/${channelId}/${index}.m3u8`;
  return { key: `${sourceId}:${url}`, channelId, name: channelId, url, urlKey: url, sourceId, status: 'unknown' } as unknown as LineEntry;
}

const baseOptions = {
  matches: () => true,
  channelIds: new Set(['c1', 'c2', 'c3', 'c4', 'c5', 'c6']),
  favorites: new Set<string>(),
  cooldown: new Map<string, number>(),
  now: Date.UTC(2026, 10, 16),
  perChannel: 5,
  limit: 10,
};

describe('selectProbeLines perSource cap', () => {
  it('never takes more than perSource lines from one source', () => {
    const lines = [
      ...['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((channel, index) => make(channel, 'src-a', index)),
      ...['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((channel, index) => make(channel, 'src-b', index)),
    ];
    const picked = selectProbeLines(lines, { ...baseOptions, takenSignatures: new Set(), perSource: 2 });
    expect(picked.filter((line) => line.sourceId === 'src-a').length).toBeLessThanOrEqual(2);
    expect(picked.filter((line) => line.sourceId === 'src-b').length).toBeLessThanOrEqual(2);
  });

  it('fills the batch from the remaining sources instead of stopping short', () => {
    const lines = [
      ...['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((channel, index) => make(channel, 'src-a', index)),
      ...['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((channel, index) => make(channel, 'src-b', index)),
    ];
    const picked = selectProbeLines(lines, { ...baseOptions, takenSignatures: new Set(), perSource: 3, limit: 6 });
    expect(picked).toHaveLength(6);
    expect(picked.filter((line) => line.sourceId === 'src-a').length).toBe(3);
    expect(picked.filter((line) => line.sourceId === 'src-b').length).toBe(3);
  });
});
