import type { LineEntry } from '../types.js';

/**
 * `state/lines.json` is the biggest artifact we publish (30k+ lines, ~19MB at
 * the time of writing). KV values are capped at 25MB and a single giant value
 * also makes every reader download the whole list. The state is therefore
 * stored as a small manifest plus N gzip-compressed shards.
 *
 * Readers keep the old single-value layout working: when the manifest is
 * missing they fall back to `state/lines.json` (see the runner/worker loaders).
 */
export const LINES_FORMAT_VERSION = 2;
export const LINES_SHARD_COUNT = 8;
export const LINES_MANIFEST_KEY = 'state/lines-manifest.json';
export const LINES_LEGACY_KEY = 'state/lines.json';

export interface LinesManifestShard {
  key: string;
  count: number;
  bytes: number;
}

export interface LinesManifest {
  version: number;
  generatedAt: string;
  total: number;
  shardCount: number;
  shards: LinesManifestShard[];
}

export interface PackedShard {
  key: string;
  body: string;
  count: number;
  bytes: number;
}

export function lineShardIndex(key: string, shardCount = LINES_SHARD_COUNT): number {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % shardCount;
}

export function lineShardKey(index: number): string {
  return `state/lines-${index}.json`;
}

/**
 * Drop empty/default fields. `headers`/`tags`/`sourceIds` are the usual
 * offenders and cost ~60 bytes per line without carrying information.
 */
export function slimLine(line: LineEntry): LineEntry {
  const slim = { ...line } as Partial<LineEntry>;
  if (slim.headers && Object.keys(slim.headers).length === 0) delete slim.headers;
  if (slim.tags && slim.tags.length === 0) delete slim.tags;
  if (slim.sourceIds && (slim.sourceIds.length === 0 || (slim.sourceIds.length === 1 && slim.sourceIds[0] === slim.sourceId))) {
    delete slim.sourceIds;
  }
  if (slim.error === '') delete slim.error;
  return slim as LineEntry;
}

/** Split lines into deterministic shards and build the manifest. */
export function packLines(
  lines: LineEntry[],
  generatedAt: string,
  shardCount = LINES_SHARD_COUNT,
): { manifest: LinesManifest; shards: PackedShard[] } {
  const buckets: LineEntry[][] = Array.from({ length: shardCount }, () => []);
  for (const line of lines) buckets[lineShardIndex(line.key, shardCount)].push(slimLine(line));

  const encoder = new TextEncoder();
  const shards: PackedShard[] = buckets.map((bucket, index) => {
    const body = JSON.stringify({ generatedAt, lines: bucket });
    return { key: lineShardKey(index), body, count: bucket.length, bytes: encoder.encode(body).byteLength };
  });
  const manifest: LinesManifest = {
    version: LINES_FORMAT_VERSION,
    generatedAt,
    total: lines.length,
    shardCount,
    shards: shards.map(({ key, count, bytes }) => ({ key, count, bytes })),
  };
  return { manifest, shards };
}

export function parseLinesBody(text: string): LineEntry[] {
  try {
    const parsed = JSON.parse(text) as { lines?: LineEntry[] };
    return Array.isArray(parsed.lines) ? parsed.lines : [];
  } catch {
    return [];
  }
}

export function isGzipBytes(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}
