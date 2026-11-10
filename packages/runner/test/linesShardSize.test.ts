import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { packLines, type LineEntry } from '@iptv/core';

/**
 * Local size check for the sharded line state. It does not hit the network:
 * it builds 33k representative lines (the production count is ~33.2k), packs
 * them exactly like the runner does, and reports raw vs gzip sizes so a human
 * can see what KV will actually store.
 */
function sampleLine(index: number): LineEntry {
  const channel = index % 600;
  return {
    key: `line-${index.toString(36)}-${(index * 2654435761).toString(36).slice(0, 6)}`,
    sourceId: `src-${(index % 43).toString(36)}`,
    sourceIds: [`src-${(index % 43).toString(36)}`],
    channelId: `channel-${channel}`,
    name: `频道 ${channel}`,
    url: `http://${10 + (index % 200)}.${index % 255}.${(index * 7) % 255}.${(index * 13) % 255}:8080/live/${index}/index.m3u8?token=${index.toString(36)}`,
    urlKey: `http://example-${channel}.com/live/${index}/index.m3u8`,
    protocol: 'hls',
    status: index % 9 === 0 ? 'dead' : index % 3 === 0 ? 'suspect' : 'alive',
    failCount: index % 4,
    resolution: '1920x1080',
    height: 1080,
    speedKbps: 2000 + (index % 5000),
    latencyMs: 20 + (index % 300),
    score: index % 100,
    tags: [],
    headers: {},
    group: '央视',
    firstSeenAt: '2026-10-01T00:00:00.000Z',
    lastSeenAt: '2026-11-10T00:00:00.000Z',
    lastProbeAt: '2026-11-10T00:00:00.000Z',
    everAlive: true,
  };
}

describe('line shard size', () => {
  it('keeps the gzipped shard total well under the 25MB KV limit', () => {
    const lines = Array.from({ length: 33_000 }, (_, index) => sampleLine(index));
    const generatedAt = '2026-11-10T00:00:00.000Z';
    const legacy = Buffer.byteLength(JSON.stringify({ generatedAt, lines }), 'utf8');
    const packed = packLines(lines, generatedAt);
    const gzipped = packed.shards.map((shard) => gzipSync(Buffer.from(shard.body, 'utf8')).byteLength);
    const totalGzip = gzipped.reduce((sum, bytes) => sum + bytes, 0);
    const manifestBytes = Buffer.byteLength(JSON.stringify(packed.manifest), 'utf8');

    console.log(
      `[line-shard-size] legacy=${(legacy / 1024 / 1024).toFixed(2)}MB gzip=${(totalGzip / 1024 / 1024).toFixed(2)}MB ` +
        `shards=${gzipped.map((bytes) => `${(bytes / 1024).toFixed(0)}KB`).join(',')} manifest=${manifestBytes}B`,
    );

    expect(packed.manifest.shards).toHaveLength(8);
    expect(legacy).toBeGreaterThan(10 * 1024 * 1024);
    expect(totalGzip).toBeLessThan(legacy * 0.25);
    for (const bytes of gzipped) expect(bytes).toBeLessThan(2 * 1024 * 1024);
  });
});
