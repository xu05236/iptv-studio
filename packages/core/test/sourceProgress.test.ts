import { describe, expect, it } from 'vitest';
import type { LineEntry } from '../src/types.js';
import { computeSourceProgress, ZERO_SOURCE_PROGRESS } from '../src/state/sourceProgress.js';

function line(partial: Partial<LineEntry> & { key: string }): LineEntry {
  return {
    channelId: 'cctv1',
    name: 'CCTV-1',
    url: 'http://a.example/live.m3u8',
    sourceId: 'src-a',
    status: 'unknown',
    ...partial,
  } as LineEntry;
}

describe('computeSourceProgress', () => {
  it('counts usable lines and leaves unmatched ones out of the buckets', () => {
    const now = new Date('2026-11-18T00:00:00Z');
    const progress = computeSourceProgress(
      [
        line({ key: 'a1', status: 'alive', lastProbeAt: '2026-11-17T00:00:00Z' }),
        line({ key: 'a2', status: 'unknown' }),
        line({ key: 'a3', url: 'rtsp://cam/live', status: 'unknown' }),
        line({ key: 'a4', channelId: 'missing', status: 'unknown' }),
      ],
      [{ id: 'cctv1' }],
      now,
    );
    const item = progress.get('src-a') ?? ZERO_SOURCE_PROGRESS;
    expect(item.total).toBe(4);
    expect(item.alive).toBe(1);
    expect(item.pending).toBe(1);
    expect(item.pendingTotal).toBe(1);
    expect(item.usableTotal).toBe(2);
    expect(item.unmatched).toBe(2);
    expect(item.channels).toBe(1);
  });

  it('returns an empty map when there are no lines', () => {
    expect(computeSourceProgress([], [], new Date()).size).toBe(0);
  });
});
