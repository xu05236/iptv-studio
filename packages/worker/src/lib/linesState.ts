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

/**
 * Parsed lines are immutable between manifest generations. Repeated admin
 * requests (sources/pool/exports) used to fetch and parse all 8 shards every
 * time; a per-isolate cache keyed by the manifest generation skips that while
 * still reading the (small) manifest so a new publish is picked up at once.
 */
const cacheByEnv = new WeakMap<Env, { generatedAt: string; total: number; lines: LineEntry[] }>();

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
    const cached = cacheByEnv.get(env);
    if (cached && cached.generatedAt === manifest.generatedAt && cached.total === manifest.total) {
      return { generatedAt: manifest.generatedAt, lines: cached.lines };
    }
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
    cacheByEnv.set(env, { generatedAt: manifest.generatedAt, total: lines.length, lines });
    return { generatedAt: manifest.generatedAt, lines };
  }
  return (await env.KV.get<LinesState>(LINES_LEGACY_KEY, 'json')) ?? { lines: [] };
}

/** Write only changed gzip shards + manifest; drop the legacy value once. */
export async function saveLines(env: Env, lines: LineEntry[], generatedAt: string, options: { allowEmpty?: boolean } = {}): Promise<void> {
  if (!lines.length && !options.allowEmpty) throw new Error('拒绝写入 0 条线路：疑似读取失败，已保留现有线路状态');
  const { manifest, shards } = packLines(lines, generatedAt);
  const previous = await env.KV.get<LinesManifest>(LINES_MANIFEST_KEY, 'json');
  const previousByKey = new Map((previous?.shards ?? []).map((shard) => [shard.key, shard]));
  let wroteShard = false;
  for (const shard of shards) {
    const prev = previousByKey.get(shard.key);
    if (prev && prev.hash && prev.hash === shard.hash && prev.count === shard.count) continue;
    await putArtifact(env, shard.key, await gzipBytes(shard.body), 'application/json; charset=utf-8');
    wroteShard = true;
  }
  if (!wroteShard && previous) manifest.generatedAt = previous.generatedAt;
  if (previous?.legacyRemoved) manifest.legacyRemoved = true;
  if (previous?.legacyRemoved !== true) {
    await deleteArtifact(env, LINES_LEGACY_KEY);
    manifest.legacyRemoved = true;
  }
  await putArtifact(env, LINES_MANIFEST_KEY, JSON.stringify(manifest), 'application/json; charset=utf-8');
  cacheByEnv.delete(env);
  // Commit happened: old shard keys (including fixed legacy keys) can now be
  // removed. Doing this before the manifest write would have made a crash
  // destructive.
  const current = new Set(shards.map((shard) => shard.key));
  for (const shard of previous?.shards ?? []) {
    if (!current.has(shard.key)) await deleteArtifact(env, shard.key).catch(() => undefined);
  }
}

export interface ManifestRepair {
  changed: boolean;
  written: boolean;
  before: { total: number; shards: Array<{ key: string; count: number }> };
  after: { total: number; shards: Array<{ key: string; count: number }> };
}

/**
 * Rebuild the manifest from the shards that actually exist. Used after an
 * interrupted write left manifest counts ahead of the shard contents; it never
 * touches the line data itself.
 */
export async function repairLinesManifest(env: Env, options: { dryRun?: boolean } = {}): Promise<ManifestRepair> {
  const manifest = await env.KV.get<LinesManifest>(LINES_MANIFEST_KEY, 'json');
  if (!manifest?.shards?.length) throw new Error('没有分片清单，无法修复');
  const shards: LinesManifest['shards'] = [];
  let total = 0;
  for (const shard of manifest.shards) {
    const bytes = await env.KV.get(shard.key, 'arrayBuffer');
    if (!bytes) throw new Error(`线路分片 ${shard.key} 读取失败，无法修复`);
    const text = isGzipBytes(new Uint8Array(bytes)) ? await gunzipText(bytes) : new TextDecoder().decode(bytes);
    const parsed = parseLinesBody(text);
    total += parsed.length;
    shards.push({ key: shard.key, count: parsed.length, bytes: shard.bytes, hash: shard.hash });
  }
  const before = { total: manifest.total, shards: manifest.shards.map(({ key, count }) => ({ key, count })) };
  const changed = total !== manifest.total || shards.some((shard, index) => shard.count !== manifest.shards[index]?.count);
  const after = { total, shards: shards.map(({ key, count }) => ({ key, count })) };
  if (!changed || options.dryRun) return { changed, written: false, before, after };
  await putArtifact(env, LINES_MANIFEST_KEY, JSON.stringify({ ...manifest, generatedAt: new Date().toISOString(), total, shards }), 'application/json; charset=utf-8');
  cacheByEnv.delete(env);
  return { changed, written: true, before, after };
}
