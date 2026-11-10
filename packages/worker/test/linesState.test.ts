import { describe, expect, it } from 'vitest';
import { LINES_LEGACY_KEY, LINES_MANIFEST_KEY, type LineEntry } from '@iptv/core';
import type { Env } from '../src/env.js';
import { loadLines, saveLines } from '../src/lib/linesState.js';

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

class FakeKV {
  readonly values = new Map<string, Uint8Array>();

  async get(key: string, type?: string): Promise<unknown> {
    const bytes = this.values.get(key);
    if (!bytes) return null;
    if (type === 'arrayBuffer') return bytes.slice().buffer;
    if (type === 'stream') return new Blob([bytes]).stream();
    const text = new TextDecoder().decode(bytes);
    if (type === 'json') return JSON.parse(text);
    return text;
  }

  async put(key: string, value: string | Uint8Array | ArrayBuffer): Promise<void> {
    const bytes = typeof value === 'string'
      ? new TextEncoder().encode(value)
      : value instanceof Uint8Array ? value : new Uint8Array(value);
    this.values.set(key, bytes);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async getWithMetadata(key: string): Promise<{ value: ReadableStream | null; metadata: unknown }> {
    return { value: this.values.has(key) ? new Blob([this.values.get(key)!]).stream() : null, metadata: null };
  }
}

function envOf(kv: FakeKV): Env {
  return { KV: kv } as unknown as Env;
}

describe('worker sharded lines', () => {
  it('writes gzip shards + manifest and reads them back', async () => {
    const kv = new FakeKV();
    await kv.put(LINES_LEGACY_KEY, JSON.stringify({ lines: [line({ key: 'old' })] }));

    await saveLines(envOf(kv), [line()], '2026-11-10T00:00:00Z');

    expect(kv.values.has(LINES_LEGACY_KEY)).toBe(false);
    const manifest = JSON.parse(new TextDecoder().decode(kv.values.get(LINES_MANIFEST_KEY))) as {
      version: number;
      total: number;
      shards: Array<{ key: string; count: number }>;
    };
    expect(manifest.version).toBe(2);
    expect(manifest.total).toBe(1);
    expect(manifest.shards).toHaveLength(8);
    const shardKey = manifest.shards.find((shard) => shard.count > 0)!.key;
    expect([...kv.values.get(shardKey)!.slice(0, 2)]).toEqual([0x1f, 0x8b]);

    const loaded = await loadLines(envOf(kv));
    expect(loaded.generatedAt).toBe('2026-11-10T00:00:00Z');
    expect(loaded.lines).toHaveLength(1);
    expect(loaded.lines[0]!.headers).toBeUndefined();
  });

  it('reads the legacy value before the first sharded publish', async () => {
    const kv = new FakeKV();
    await kv.put(LINES_LEGACY_KEY, JSON.stringify({ generatedAt: '2026-11-09T00:00:00Z', lines: [line({ key: 'legacy' })] }));
    const loaded = await loadLines(envOf(kv));
    expect(loaded.generatedAt).toBe('2026-11-09T00:00:00Z');
    expect(loaded.lines[0]!.key).toBe('legacy');
  });
});
