import { describe, expect, it } from 'vitest';
import type { LineEntry } from '@iptv/core';
import { dedupeProbeTargets, fanoutProbeResults } from '../src/pipeline/probe.js';

function makeLine(over: Partial<LineEntry> & { key: string }): LineEntry {
  return {
    sourceId: 'src-a',
    channelId: 'cctv1',
    name: 'CCTV-1',
    url: 'http://example.com/a.m3u8',
    urlKey: 'http://example.com/a.m3u8',
    protocol: 'hls',
    status: 'unknown',
    failCount: 0,
    score: 0,
    firstSeenAt: '2026-11-01T00:00:00Z',
    lastSeenAt: '2026-11-01T00:00:00Z',
    tags: [],
    ...over,
  };
}

describe('dedupeProbeTargets', () => {
  it('collapses cross-source duplicates into one representative', () => {
    const alive = makeLine({ key: 'k-alive', sourceId: 'src-b', status: 'alive', lastProbeAt: '2026-11-09T00:00:00Z' });
    const unknown = makeLine({ key: 'k-unknown', sourceId: 'src-a' });
    const targets = dedupeProbeTargets([unknown, alive]);
    expect(targets).toHaveLength(1);
    // Prefer the line that already has a proven result.
    expect(targets[0]?.key).toBe('k-alive');
  });

  it('keeps lines with different request headers separate', () => {
    const plain = makeLine({ key: 'k-plain' });
    const withUa = makeLine({ key: 'k-ua', headers: { 'user-agent': 'okhttp/4.9' } });
    expect(dedupeProbeTargets([plain, withUa])).toHaveLength(2);
  });

  it('treats different urls as different targets', () => {
    const a = makeLine({ key: 'k-a', url: 'http://example.com/a.m3u8', urlKey: 'http://example.com/a.m3u8' });
    const b = makeLine({ key: 'k-b', url: 'http://example.com/b.m3u8', urlKey: 'http://example.com/b.m3u8' });
    expect(dedupeProbeTargets([a, b])).toHaveLength(2);
  });
});

describe('fanoutProbeResults', () => {
  it('copies the result to duplicates while keeping their identity fields', () => {
    const representative = makeLine({
      key: 'k-rep',
      status: 'alive',
      speedKbps: 4200,
      resolution: '1920x1080',
      lastProbeAt: '2026-11-10T03:00:00Z',
      everAlive: true,
      score: 91,
    });
    const sibling = makeLine({ key: 'k-sib', sourceId: 'src-b', channelId: 'cctv1-hd', name: 'CCTV-1 高清' });
    const copied = fanoutProbeResults([representative, sibling], [representative]);
    expect(copied).toBe(1);
    expect(sibling.status).toBe('alive');
    expect(sibling.speedKbps).toBe(4200);
    expect(sibling.resolution).toBe('1920x1080');
    expect(sibling.score).toBe(91);
    // Identity is untouched.
    expect(sibling.key).toBe('k-sib');
    expect(sibling.sourceId).toBe('src-b');
    expect(sibling.name).toBe('CCTV-1 高清');
  });

  it('never touches official lines', () => {
    const representative = makeLine({ key: 'k-rep', status: 'alive', lastProbeAt: '2026-11-10T03:00:00Z' });
    const official = makeLine({ key: 'k-official', official: true, status: 'alive' });
    const copied = fanoutProbeResults([representative, official], [representative]);
    expect(copied).toBe(0);
    expect(official.status).toBe('alive');
  });

  it('ignores representatives that were not probed', () => {
    const stale = makeLine({ key: 'k-stale', status: 'unknown' });
    const sibling = makeLine({ key: 'k-sib', status: 'unknown' });
    expect(fanoutProbeResults([stale, sibling], [stale])).toBe(0);
    expect(sibling.status).toBe('unknown');
  });
});
