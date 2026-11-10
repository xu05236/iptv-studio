import { describe, expect, it } from 'vitest';
import type { LineEntry } from '@iptv/core';
import { mergeArchive, splitArchivable } from '../src/pipeline/archive.js';

const NOW = Date.parse('2026-11-10T00:00:00Z');

function line(key: string, extra: Partial<LineEntry> = {}): LineEntry {
  return {
    key,
    name: key,
    url: `http://example.test/${key}`,
    channelId: 'cctv1',
    sourceId: 'src-1',
    status: 'dead',
    protocol: 'hls',
    ...extra,
  } as unknown as LineEntry;
}

describe('splitArchivable', () => {
  it('archives dead lines probed long ago', () => {
    const { keep, archived } = splitArchivable([line('old', { lastProbeAt: '2026-01-01T00:00:00Z' })], NOW);
    expect(archived.map((item) => item.key)).toEqual(['old']);
    expect(keep).toHaveLength(0);
  });

  it('keeps recently dead and still-alive lines', () => {
    const { keep, archived } = splitArchivable(
      [line('recent', { lastProbeAt: '2026-11-09T00:00:00Z' }), line('alive', { status: 'alive' })],
      NOW,
    );
    expect(archived).toHaveLength(0);
    expect(keep.map((item) => item.key).sort()).toEqual(['alive', 'recent']);
  });

  it('archives dead lines that were never probed', () => {
    const { archived } = splitArchivable([line('never')], NOW);
    expect(archived.map((item) => item.key)).toEqual(['never']);
  });
});

describe('mergeArchive', () => {
  it('dedupes by key and prefers the newest copy', () => {
    const merged = mergeArchive(
      [line('a', { lastProbeAt: '2026-01-01T00:00:00Z' }), line('b', { lastProbeAt: '2026-02-01T00:00:00Z' })],
      [line('a', { lastProbeAt: '2026-03-01T00:00:00Z' })],
    );
    expect(merged).toHaveLength(2);
    expect(merged.find((item) => item.key === 'a')?.lastProbeAt).toBe('2026-03-01T00:00:00Z');
  });

  it('caps the archive at the newest entries', () => {
    const merged = mergeArchive(
      [line('b', { lastProbeAt: '2026-02-01T00:00:00Z' })],
      [line('a', { lastProbeAt: '2026-03-01T00:00:00Z' })],
      1,
    );
    expect(merged.map((item) => item.key)).toEqual(['a']);
  });
});
