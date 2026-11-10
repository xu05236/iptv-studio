import {
  isGzipBytes,
  LINES_FORMAT_VERSION,
  LINES_LEGACY_KEY,
  LINES_MANIFEST_KEY,
  packLines,
  parseLinesBody,
  type LineEntry,
  type LinesManifest,
} from '@iptv/core';
import type { Env } from '../env.js';
import { deleteArtifact, putArtifact } from './store.js';

export interface LinesState {
  generatedAt?: string;
  lines: LineEntry[];
}

async function gzipBytes(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipText(bytes: ArrayBuffer): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

async function readShard(env: Env, key: string): Promise<LineEntry[]> {
  const bytes = await env.KV.get(key, 'arrayBuffer');
  if (!bytes) throw new Error(`线路分片 ${key} 读取失败，已中止以保护现有线路状态`);
  const text = isGzipBytes(new Uint8Array(bytes)) ? await gunzipText(bytes) : new TextDecoder().decode(bytes);
  return parseLinesBody(text);
}

/** Load sharded lines; falls back to the legacy single value. */
export async function loadLines(env: Env): Promise<LinesState> {
  const manifest = await env.KV.get<LinesManifest>(LINES_MANIFEST_KEY, 'json');
  if (manifest?.version === LINES_FORMAT_VERSION && manifest.shards?.length) {
    const lines: LineEntry[] = [];
    for (const shard of manifest.shards) {
      const parsed = await readShard(env, shard.key);
      // Counts in the manifest make an interrupted publish (new shard, old
      // manifest) fail closed instead of silently loading a mixed state.
      if (typeof shard.count === 'number' && parsed.length !== shard.count) {
        throw new Error(`线路分片 ${shard.key} 条数不符（${parsed.length}/${shard.count}），疑似发布中断，已中止以保护现有线路状态`);
      }
      lines.push(...parsed);
    }
    if (lines.length < manifest.total) {
      throw new Error(`线路分片读取不完整（${lines.length}/${manifest.total}），已中止以保护现有线路状态`);
    }
    return { generatedAt: manifest.generatedAt, lines };
  }
  return (await env.KV.get<LinesState>(LINES_LEGACY_KEY, 'json')) ?? { lines: [] };
}

/** Write gzip shards + manifest; drop the legacy value once shards exist. */
export async function saveLines(env: Env, lines: LineEntry[], generatedAt: string, options: { allowEmpty?: boolean } = {}): Promise<void> {
  if (!lines.length && !options.allowEmpty) throw new Error('拒绝写入 0 条线路：疑似读取失败，已保留现有线路状态');
  const { manifest, shards } = packLines(lines, generatedAt);
  for (const shard of shards) {
    await putArtifact(env, shard.key, await gzipBytes(shard.body), 'application/json; charset=utf-8');
  }
  await putArtifact(env, LINES_MANIFEST_KEY, JSON.stringify(manifest), 'application/json; charset=utf-8');
  await deleteArtifact(env, LINES_LEGACY_KEY);
}
