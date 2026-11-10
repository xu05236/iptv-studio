import { describe, expect, it } from 'vitest';
import type { LineEntry } from '../src/types.js';
import { computeSourceOverlap } from '../src/state/overlap.js';

function line(url: string, sourceId: string, firstSeenAt: string): LineEntry {
  return { key: `${sourceId}:${url}`, channelId: 'cctv1', name: 'CCTV-1', url, sourceId, firstSeenAt } as unknown as LineEntry;
}

describe('computeSourceOverlap', () => {
  it('counts a shared URL once and attributes it to both sources', () => {
    const report = computeSourceOverlap(
      [
        line('http://a.example/live.m3u8', 'src-a', '2026-11-01T00:00:00Z'),
        line('http://a.example/live.m3u8', 'src-b', '2026-11-02T00:00:00Z'),
        line('http://a.example/live.m3u8?token=1', 'src-b', '2026-11-02T00:00:00Z'),
      ],
      '2026-11-10T00:00:00Z',
    );
    expect(report.totalLines).toBe(3);
    expect(report.uniqueUrls).toBe(1);
    expect(report.duplicateUrls).toBe(1);
    expect(report.duplicatedLines).toBe(3);
    const a = report.items.find((item) => item.sourceId === 'src-a');
    const b = report.items.find((item) => item.sourceId === 'src-b');
    expect(a).toMatchObject({ total: 1, duplicated: 1, unique: 0, earliestWins: 1 });
    expect(b).toMatchObject({ total: 2, duplicated: 1, unique: 0, earliestWins: 0 });
    expect(b?.share).toBe(0.5);
  });

  it('keeps unique URLs out of the duplicate counts', () => {
    const report = computeSourceOverlap(
      [
        line('http://a.example/1.m3u8', 'src-a', '2026-11-01T00:00:00Z'),
        line('http://b.example/2.m3u8', 'src-b', '2026-11-01T00:00:00Z'),
      ],
      '2026-11-10T00:00:00Z',
    );
    expect(report.duplicateUrls).toBe(0);
    expect(report.items.every((item) => item.duplicated === 0 && item.unique === 1)).toBe(true);
  });

  it('sorts sources by duplicated count then unique count', () => {
    const report = computeSourceOverlap(
      [
        line('http://a.example/1.m3u8', 'src-a', '2026-11-01T00:00:00Z'),
        line('http://a.example/1.m3u8', 'src-b', '2026-11-02T00:00:00Z'),
        line('http://b.example/2.m3u8', 'src-b', '2026-11-02T00:00:00Z'),
        line('http://c.example/3.m3u8', 'src-c', '2026-11-03T00:00:00Z'),
      ],
      '2026-11-10T00:00:00Z',
    );
    expect(report.items.map((item) => item.sourceId)).toEqual(['src-b', 'src-a', 'src-c']);
  });
});
