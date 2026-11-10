import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { LINES_LEGACY_KEY, LINES_MANIFEST_KEY, type LineEntry } from '@iptv/core';
import type { ArtifactStore } from '../src/store.js';
import { loadLinesState, saveLinesState } from '../src/lib/linesState.js';

function line(overrides: Partial<LineEntry> = {}): LineEntry {
  return {
    key: 'k1',
    sourceId: 's1',
    channelId: 'cctv1',
    name: 'CCTV1',
    url: 'http://a/1.m3u8',
    urlKey: 'http://a/1.m3u8',
    protocol: 'hls',
    status: 'alive',
    failCount: 0,
    score: 90,
    tags: [],
    headers: {},
    sourceIds: ['s1'],
    firstSeenAt: '2026-01-01T00:00:00Z',
    lastSeenAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

class MemoryStore {
  readonly values = new Map<string, string>();

  async put(key: string, body: string | Uint8Array): Promise<void> {
    this.values.set(key, typeof body === 'string' ? body : gunzipSync(body).toString('utf8'));
  }

  async getText(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async getJson<T>(key: string): Promise<T | null> {
    const text = this.values.get(key);
    return text ? (JSON.parse(text) as T) : null;
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

describe('lines state sharding', () => {
  it('round-trips lines through gzip shards and drops the legacy value', async () => {
    const store = new MemoryStore();
    store.values.set(LINES_LEGACY_KEY, JSON.stringify({ lines: [line({ key: 'old' })] }));

    await saveLinesState(store as unknown as ArtifactStore, [line()], '2026-01-02T00:00:00Z');

    expect(store.values.has(LINES_LEGACY_KEY)).toBe(false);
    const manifest = JSON.parse(store.values.get(LINES_MANIFEST_KEY)!) as { version: number; total: number; shards: unknown[] };
    expect(manifest.version).toBe(2);
    expect(manifest.total).toBe(1);
    expect(manifest.shards).toHaveLength(8);

    const loaded = await loadLinesState(store as unknown as ArtifactStore);
    expect(loaded.generatedAt).toBe('2026-01-02T00:00:00Z');
    expect(loaded.lines).toHaveLength(1);
    // slimLine removed the empty headers/tags and redundant sourceIds.
    expect(loaded.lines[0]!.headers).toBeUndefined();
    expect(loaded.lines[0]!.tags).toBeUndefined();
    expect(loaded.lines[0]!.sourceIds).toBeUndefined();
  });

  it('falls back to the legacy single value when no manifest exists', async () => {
    const store = new MemoryStore();
    store.values.set(LINES_LEGACY_KEY, JSON.stringify({ generatedAt: '2026-01-03T00:00:00Z', lines: [line({ key: 'legacy' })] }));
    const loaded = await loadLinesState(store as unknown as ArtifactStore);
    expect(loaded.generatedAt).toBe('2026-01-03T00:00:00Z');
    expect(loaded.lines[0]!.key).toBe('legacy');
  });

  it('spreads many lines across all shards', async () => {
    const store = new MemoryStore();
    const lines = Array.from({ length: 200 }, (_, index) => line({ key: `line-${index}` }));
    await saveLinesState(store as unknown as ArtifactStore, lines, '2026-01-04T00:00:00Z');
    const manifest = JSON.parse(store.values.get(LINES_MANIFEST_KEY)!) as { shards: Array<{ count: number }> };
    expect(manifest.shards.reduce((sum, shard) => sum + shard.count, 0)).toBe(200);
    expect(manifest.shards.every((shard) => shard.count > 0)).toBe(true);
    const loaded = await loadLinesState(store as unknown as ArtifactStore);
    expect(loaded.lines).toHaveLength(200);
  });
});
