import { gzipSync } from 'node:zlib';
import {
  LINES_FORMAT_VERSION,
  LINES_LEGACY_KEY,
  LINES_MANIFEST_KEY,
  packLines,
  parseLinesBody,
  type LineEntry,
  type LinesManifest,
} from '@iptv/core';
import type { ArtifactStore } from '../store.js';

export interface LinesState {
  generatedAt?: string;
  lines: LineEntry[];
}

/**
 * Load the line state from either the sharded manifest or the legacy
 * single-value file. ArtifactStore.getText() transparently gunzips values, so
 * both gzip and plain shards are accepted.
 */
export async function loadLinesState(store: ArtifactStore): Promise<LinesState> {
  const manifest = await store.getJson<LinesManifest>(LINES_MANIFEST_KEY).catch(() => null);
  if (manifest?.version === LINES_FORMAT_VERSION && manifest.shards?.length) {
    const lines: LineEntry[] = [];
    for (const shard of manifest.shards) {
      const text = await store.getText(shard.key).catch(() => null);
      if (!text) {
        // Never hand a partial state back to callers: they save it straight away
        // (single-source fetch, prune, publish) and would erase every shard we
        // failed to read. Fail loudly and keep the stored state untouched.
        throw new Error(`线路分片 ${shard.key} 读取失败，已中止以保护现有线路状态`);
      }
      lines.push(...parseLinesBody(text));
    }
    if (lines.length < manifest.total) {
      throw new Error(`线路分片读取不完整（${lines.length}/${manifest.total}），已中止以保护现有线路状态`);
    }
    return { generatedAt: manifest.generatedAt, lines };
  }
  return (await store.getJson<LinesState>(LINES_LEGACY_KEY)) ?? { lines: [] };
}

/** Write 8 gzip shards + manifest, then remove the legacy single value. */
export async function saveLinesState(store: ArtifactStore, lines: LineEntry[], generatedAt: string): Promise<void> {
  if (!lines.length) {
    // A zero-line state is almost always a failed read, not an intentional
    // wipe. Refuse it so one transient shard failure cannot destroy the pool.
    throw new Error('拒绝写入 0 条线路：疑似读取失败，已保留现有线路状态');
  }
  const { manifest, shards } = packLines(lines, generatedAt);
  for (const shard of shards) {
    const compressed = new Uint8Array(gzipSync(Buffer.from(shard.body)));
    await store.put(shard.key, compressed, 'application/json; charset=utf-8');
  }
  await store.put(LINES_MANIFEST_KEY, JSON.stringify(manifest), 'application/json; charset=utf-8');
  await store.delete(LINES_LEGACY_KEY).catch(() => undefined);
}
