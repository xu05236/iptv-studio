import { describe, expect, it } from 'vitest';
import type { LineEntry } from '../src/types.js';
import { slimExportLine, slimPoolSnapshot } from '../src/state/exportLines.js';
import type { PoolSnapshot } from '../src/linePool.js';

function line(partial: Partial<LineEntry> = {}): LineEntry {
  return {
    key: 'k1',
    sourceId: 'src-a',
    channelId: 'cctv1',
    name: 'CCTV-1',
    url: 'http://a.example/live.m3u8',
    urlKey: 'a.example/live.m3u8',
    protocol: 'hls',
    status: 'alive',
    failCount: 0,
    passCount: 3,
    score: 80,
    resolution: '1080p',
    height: 1080,
    speedKbps: 5000,
    latencyMs: 120,
    bandwidthKbps: 1800,
    firstSeenAt: '2026-01-01T00:00:00Z',
    lastSeenAt: '2026-01-02T00:00:00Z',
    lastProbeAt: '2026-01-03T00:00:00Z',
    tags: ['a', 'b'],
    headers: { Referer: 'http://a.example' },
    region: '江苏',
    operator: '电信',
    official: true,
    favorite: true,
    cnReachable: true,
    ...partial,
  };
}

describe('slimExportLine', () => {
  it('keeps render fields and drops probe/lifecycle fields', () => {
    const slim = slimExportLine(line());
    expect(slim).toMatchObject({
      key: 'k1',
      sourceId: 'src-a',
      name: 'CCTV-1',
      url: 'http://a.example/live.m3u8',
      status: 'alive',
      score: 80,
      resolution: '1080p',
      height: 1080,
      speedKbps: 5000,
      lastProbeAt: '2026-01-03T00:00:00Z',
      region: '江苏',
      operator: '电信',
      official: true,
      favorite: true,
      cnReachable: true,
      headers: { Referer: 'http://a.example' },
    });
    expect(slim.passCount).toBeUndefined();
    expect(slim.latencyMs).toBe(120);
    // Only the build path reads these values; artifacts keep empty placeholders.
    expect(slim.urlKey).toBe('');
    expect(slim.firstSeenAt).toBe('');
    expect(slim.lastSeenAt).toBe('');
    expect(slim.tags).toEqual([]);
    expect(slim.bandwidthKbps).toBeUndefined();
  });

  it('omits empty optional fields', () => {
    const slim = slimExportLine(line({ headers: undefined, region: undefined, official: undefined, favorite: undefined, cnReachable: undefined }));
    expect(slim.headers).toBeUndefined();
    expect(slim.region).toBeUndefined();
    expect(slim.official).toBeUndefined();
    expect(slim.favorite).toBeUndefined();
    expect(slim.cnReachable).toBeUndefined();
  });
});

describe('slimPoolSnapshot', () => {
  it('slims all three buckets', () => {
    const snapshot: PoolSnapshot = {
      generatedAt: '2026-01-03T00:00:00Z',
      channels: {
        cctv1: {
          channel: { id: 'cctv1', name: 'CCTV-1', group: '央视' },
          premium: [line({ key: 'p' })],
          backup: [line({ key: 'b' })],
          candidate: [line({ key: 'c' })],
        },
      },
    };
    const slimmed = slimPoolSnapshot(snapshot);
    for (const bucket of [slimmed.channels.cctv1.premium, slimmed.channels.cctv1.backup, slimmed.channels.cctv1.candidate]) {
      expect(bucket[0].passCount).toBeUndefined();
      expect(bucket[0].latencyMs).toBe(120);
      expect(bucket[0].url).toBe('http://a.example/live.m3u8');
    }
  });
});
