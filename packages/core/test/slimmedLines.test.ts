import { describe, expect, it } from 'vitest';
import { dedupeLines } from '../src/aggregate/dedupe.js';
import { parseLinesBody } from '../src/state/lines.js';
import type { LineEntry } from '../src/types.js';

function bare(): LineEntry {
  return {
    key: 'k1',
    channelId: 'cctv1',
    name: 'CCTV-1',
    url: 'http://a.example/1.m3u8',
    urlKey: 'http://a.example/1.m3u8',
    sourceId: 'src-a',
    firstSeenAt: '2026-11-01T00:00:00Z',
    lastSeenAt: '2026-11-01T00:00:00Z',
    status: 'alive',
  } as unknown as LineEntry;
}

describe('slimmed line state', () => {
  it('restores tags when parsing stored shards', () => {
    const lines = parseLinesBody(JSON.stringify({ generatedAt: 'x', lines: [{ ...bare(), tags: undefined }] }));
    expect(lines[0]?.tags).toEqual([]);
  });

  it('dedupes lines that have no tags array', () => {
    const merged = dedupeLines([bare(), { ...bare(), key: 'k2', sourceId: 'src-b' } as unknown as LineEntry]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.tags).toEqual([]);
  });
});
