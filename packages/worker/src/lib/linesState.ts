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
  if (!bytes) return [];
  const text = isGzipBytes(new Uint8Array(bytes)) ? await gunzipText(bytes) : new TextDecoder().decode(bytes);
  return parseLinesBody(text);
}

/** Load sharded lines; falls back to the legacy single value. */
export async function loadLines(env: Env): Promise<LinesState> {
  const manifest = await env.KV.get<LinesManifest>(LINES_MANIFEST_KEY, 'json');
  if (manifest?.version === LINES_FORMAT_VERSION && manifest.shards?.length) {
    const lines: LineEntry[] = [];
    for (const shard of manifest.shards) lines.push(...(await readShard(env, shard.key)));
    return { generatedAt: manifest.generatedAt, lines };
  }
  return (await env.KV.get<LinesState>(LINES_LEGACY_KEY, 'json')) ?? { lines: [] };
}

/** Write gzip shards + manifest; drop the legacy value once shards exist. */
export async function saveLines(env: Env, lines: LineEntry[], generatedAt: string): Promise<void> {
  const { manifest, shards } = packLines(lines, generatedAt);
  for (const shard of shards) {
    await putArtifact(env, shard.key, await gzipBytes(shard.body), 'application/json; charset=utf-8');
  }
  await putArtifact(env, LINES_MANIFEST_KEY, JSON.stringify(manifest), 'application/json; charset=utf-8');
  await deleteArtifact(env, LINES_LEGACY_KEY);
}
