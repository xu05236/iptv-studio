import { describe, expect, it } from 'vitest';
import { buildPoolSnapshot, canonicalPoolUrl, dedupePoolLines, qualityConfirmed, withinRetention } from '../src/linePool.js';
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
    lastProbeAt: '2026-01-01T00:00:00Z',
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
      line({ url: 'f', key: 'f', lastProbeAt: undefined }),
      line({ url: 'a', key: 'a2', score: 10 }),
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

  it('keeps unknown quality as candidate even when the pool is unlimited', () => {
    const snapshot = buildPoolSnapshot({
      lines: [
        line({ url: 'a', key: 'a', score: 90 }),
        line({ url: 'd', key: 'd', resolution: undefined, height: undefined, score: 95 }),
      ],
      channels: [{ id: 'cctv1', name: 'CCTV-1', group: '央视', tvgId: 'CCTV1' }],
      maxLinesPerChannel: 0,
      generatedAt: '2026-10-30T00:00:00Z',
    });
    expect(snapshot.channels.cctv1.premium.map((item) => item.key)).toEqual(['a']);
    expect(snapshot.channels.cctv1.candidate.map((item) => item.key)).toEqual(['d']);
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

describe('dedupePoolLines', () => {
  it('collapses scheme variants and prefers the alive record', () => {
    const lines = [
      line({ url: '//host/live.m3u8', key: 'a', status: 'unknown', lastProbeAt: undefined }),
      line({ url: 'http://host/live.m3u8', key: 'b', status: 'alive', score: 90 }),
    ];
    const deduped = dedupePoolLines(lines);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.key).toBe('b');
    expect(deduped[0]?.status).toBe('alive');
  });

  it('prefers the newer probe when both are alive', () => {
    const older = line({ url: 'http://host/x', key: 'old', lastProbeAt: '2026-01-01T00:00:00Z' });
    const newer = line({ url: 'http://host/x', key: 'new', lastProbeAt: '2026-10-01T00:00:00Z' });
    const deduped = dedupePoolLines([older, newer]);
    expect(deduped[0]?.key).toBe('new');
  });
});

describe('retention helpers', () => {
  it('normalises scheme-relative URLs', () => {
    expect(canonicalPoolUrl('//host/a')).toBe('http://host/a');
    expect(canonicalPoolUrl(' https://host/a ')).toBe('https://host/a');
  });

  it('keeps lines inside the retention window and drops older ones', () => {
    const now = Date.parse('2026-10-30T00:00:00Z');
    expect(withinRetention('2026-10-20T00:00:00Z', now, 30)).toBe(true);
    expect(withinRetention('2026-08-01T00:00:00Z', now, 30)).toBe(false);
    expect(withinRetention(undefined, now, 30)).toBe(false);
    expect(withinRetention('2026-10-30T00:00:00Z', now, 0)).toBe(true);
  });
});
