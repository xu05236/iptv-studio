import { describe, expect, it } from 'vitest';
import { buildPoolSnapshot, qualityConfirmed } from '../src/linePool.js';
import type { LineEntry } from '../src/types.js';

function line(overrides: Partial<LineEntry> & { url: string }): LineEntry {
  return {
    key: overrides.key ?? overrides.url,
    sourceId: 's1',
    channelId: 'cctv1',
    name: 'CCTV1',
    url: overrides.url,
    urlKey: overrides.url,
    protocol: 'hls',
    status: 'alive',
    failCount: 0,
    score: overrides.score ?? 0,
    resolution: '1920x1080',
    height: 1080,
    speedKbps: 4000,
    firstSeenAt: '2026-01-01T00:00:00Z',
    lastSeenAt: '2026-01-01T00:00:00Z',
    tags: [],
    ...overrides,
  };
}

describe('buildPoolSnapshot', () => {
  it('splits confirmed alive lines into premium/backup and keeps unknown quality as candidate', () => {
    const lines = [
      line({ url: 'a', key: 'a', score: 90 }),
      line({ url: 'b', key: 'b', score: 80 }),
      line({ url: 'c', key: 'c', score: 70 }),
      line({ url: 'd', key: 'd', resolution: undefined, height: undefined, score: 95 }),
      line({ url: 'e', key: 'e', status: 'suspect' }),
      line({ url: 'a2', key: 'a2', urlKey: 'a', score: 10 }),
    ];
    const snapshot = buildPoolSnapshot({
      lines,
      channels: [{ id: 'cctv1', name: 'CCTV-1', group: '央视', tvgId: 'CCTV1' }],
      maxLinesPerChannel: 1,
      generatedAt: '2026-10-30T00:00:00Z',
    });
    const channel = snapshot.channels.cctv1;
    expect(channel.premium.map((item) => item.key)).toEqual(['a', 'b']);
    expect(channel.backup.map((item) => item.key)).toEqual(['c']);
    expect(channel.candidate.map((item) => item.key)).toEqual(['d']);
    expect(channel.premium.every((item) => item.status === 'alive')).toBe(true);
  });

  it('drops lines whose channel no longer exists', () => {
    const snapshot = buildPoolSnapshot({
      lines: [line({ url: 'a', channelId: 'removed' })],
      channels: [{ id: 'cctv1', name: 'CCTV-1', group: '央视' }],
      maxLinesPerChannel: 3,
      generatedAt: '2026-10-30T00:00:00Z',
    });
    expect(snapshot.channels).toEqual({});
  });
});

describe('qualityConfirmed', () => {
  it('treats known height or a real resolution string as confirmed', () => {
    expect(qualityConfirmed({ resolution: '1920x1080' })).toBe(true);
    expect(qualityConfirmed({ resolution: undefined, height: 720 })).toBe(true);
    expect(qualityConfirmed({ resolution: 'unknown' })).toBe(false);
    expect(qualityConfirmed({ resolution: undefined })).toBe(false);
  });
});
