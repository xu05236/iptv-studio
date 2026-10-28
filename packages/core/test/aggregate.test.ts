import { describe, expect, it } from 'vitest';
import { dedupeLines } from '../src/aggregate/dedupe.js';
import { selectLines } from '../src/aggregate/merge.js';
import { transition, shouldExport, isDueForProbe } from '../src/aggregate/state.js';
import { scoreLine } from '../src/aggregate/rank.js';
import type { LineEntry } from '../src/types.js';

function line(overrides: Partial<LineEntry>): LineEntry {
  return {
    key: 'k',
    sourceId: 's1',
    channelId: 'cctv1',
    name: 'CCTV1',
    url: 'http://a/1.m3u8',
    urlKey: 'http://a/1.m3u8',
    protocol: 'hls',
    status: 'alive',
    failCount: 0,
    score: 50,
    tags: [],
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    lastProbeAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('state machine', () => {
  it('demotes after failures and revives on success', () => {
    let state: { status: 'alive' | 'suspect' | 'dead' | 'unknown'; failCount: number; reviveAt?: string } = { status: 'alive', failCount: 0 };
    state = transition(state, { ok: false, error: 'HTTP 500' }, { reviveDays: 14 });
    expect(state.status).toBe('suspect');
    expect(state.failCount).toBe(1);
    state = transition(state, { ok: false, error: 'HTTP 500' });
    state = transition(state, { ok: false, error: 'HTTP 500' });
    expect(state.status).toBe('dead');
    expect(state.reviveAt).toBeTruthy();
    expect(transition(state, { ok: true }).status).toBe('alive');
  });

  it('does not judge protocols it cannot probe', () => {
    const state = transition({ status: 'alive', failCount: 0 }, { ok: false, error: 'RTSP 协议无法在 HTTP 环境中探测（需在本机用 ffprobe）' });
    expect(state.skipped).toBe(true);
    expect(state.status).toBe('alive');
  });

  it('exports one-failure lines only as compensation', () => {
    const suspect = line({ status: 'suspect', failCount: 1 });
    expect(shouldExport(suspect, 3, { compensate: true, keepSuspect: true })).toBe(false);
    expect(shouldExport(suspect, 0, { compensate: true, keepSuspect: true })).toBe(true);
    expect(shouldExport(suspect, 0, { compensate: false, keepSuspect: true })).toBe(false);
  });

  it('schedules retries by tier', () => {
    const now = new Date('2026-02-01T00:00:00Z');
    expect(isDueForProbe(line({ lastProbeAt: '2026-01-31T20:00:00Z', status: 'alive' }), 'normal', now)).toBe(false);
    expect(isDueForProbe(line({ lastProbeAt: '2026-01-31T10:00:00Z', status: 'alive' }), 'high', now)).toBe(true);
  });
});

describe('dedupe', () => {
  it('merges the same URL reported by two sources', () => {
    const a = line({ sourceId: 's1', status: 'alive', score: 80, firstSeenAt: '2026-01-01T00:00:00Z' });
    const b = line({ sourceId: 's2', status: 'alive', score: 60, firstSeenAt: '2026-02-01T00:00:00Z' });
    const merged = dedupeLines([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.sourceId).toBe('s1');
    expect(merged[0]!.firstSeenAt).toBe('2026-01-01T00:00:00Z');
  });

  it('keeps genuinely different urls', () => {
    const merged = dedupeLines([line({ urlKey: 'http://a/1' }), line({ urlKey: 'http://a/2' })]);
    expect(merged).toHaveLength(2);
  });
});

describe('selectLines', () => {
  const base = {
    maxLines: 3,
    maxPerSource: 2,
    minQuality: 'any' as const,
    minSpeedKbps: 0,
    compensate: true,
    keepSuspect: true,
  };

  it('ranks faster lines first and caps per source', () => {
    const lines = [
      line({ key: '1', sourceId: 'a', urlKey: 'u1', speedKbps: 800, resolution: '1080p', score: 90 }),
      line({ key: '2', sourceId: 'a', urlKey: 'u2', speedKbps: 700, resolution: '1080p', score: 85 }),
      line({ key: '3', sourceId: 'a', urlKey: 'u3', speedKbps: 600, resolution: '720p', score: 80 }),
      line({ key: '4', sourceId: 'b', urlKey: 'u4', speedKbps: 500, resolution: '720p', score: 70 }),
    ];
    const picked = selectLines(lines, { ...base, maxLines: 2 });
    expect(picked).toHaveLength(2);
    expect(picked.map((item) => item.sourceId)).toEqual(['a', 'a']);

    const diversified = selectLines(lines, { ...base, maxLines: 4, maxPerSource: 1 });
    expect(diversified.map((item) => item.sourceId)).toEqual(['a', 'b']);
  });

  it('drops clearly inferior resolutions and speeds', () => {
    const lines = [
      line({ key: '1', sourceId: 'a', urlKey: 'u1', speedKbps: 8000, resolution: '1080p', height: 1080, score: 90 }),
      line({ key: '2', sourceId: 'b', urlKey: 'u2', speedKbps: 7000, resolution: '1080p', height: 1080, score: 85 }),
      line({ key: '3', sourceId: 'c', urlKey: 'u3', speedKbps: 600, resolution: '480p', height: 480, score: 40 }),
    ];
    const picked = selectLines(lines, { ...base, maxLines: 6 });
    expect(picked.every((item) => item.resolution === '1080p')).toBe(true);
  });

  it('falls back to lower quality when filters would empty the channel', () => {
    const lines = [line({ key: '1', urlKey: 'u1', resolution: '720p', speedKbps: 200 })];
    const picked = selectLines(lines, { ...base, minQuality: '1080p', minSpeedKbps: 1000 });
    expect(picked).toHaveLength(1);
  });
});

describe('scoring', () => {
  it('prefers fast 1080p over slow 4K', () => {
    const fast = scoreLine({ speedKbps: 4000, resolution: '1080p', status: 'alive', failCount: 0, protocol: 'hls', sourceReputation: 80 });
    const slow = scoreLine({ speedKbps: 300, resolution: '2160p', status: 'alive', failCount: 0, protocol: 'hls', sourceReputation: 80 });
    expect(fast).toBeGreaterThan(slow);
  });

  it('penalises ad loops', () => {
    const normal = scoreLine({ speedKbps: 2000, resolution: '1080p', status: 'alive', failCount: 0, protocol: 'hls' });
    const loop = scoreLine({ speedKbps: 2000, resolution: '1080p', status: 'alive', failCount: 0, protocol: 'hls', loop: true });
    expect(loop).toBeLessThan(normal);
  });
});
