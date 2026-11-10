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
      if (text) lines.push(...parseLinesBody(text));
    }
    return { generatedAt: manifest.generatedAt, lines };
  }
  return (await store.getJson<LinesState>(LINES_LEGACY_KEY)) ?? { lines: [] };
}

/** Write 8 gzip shards + manifest, then remove the legacy single value. */
export async function saveLinesState(store: ArtifactStore, lines: LineEntry[], generatedAt: string): Promise<void> {
  const { manifest, shards } = packLines(lines, generatedAt);
  for (const shard of shards) {
    const compressed = new Uint8Array(gzipSync(Buffer.from(shard.body)));
    await store.put(shard.key, compressed, 'application/json; charset=utf-8');
  }
  await store.put(LINES_MANIFEST_KEY, JSON.stringify(manifest), 'application/json; charset=utf-8');
  await store.delete(LINES_LEGACY_KEY).catch(() => undefined);
}
