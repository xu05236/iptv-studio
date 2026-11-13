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
  /** Content hash; lets writers skip unchanged shards (KV puts are the scarce resource). */
  hash?: string;
}

export interface LinesManifest {
  version: number;
  generatedAt: string;
  total: number;
  shardCount: number;
  shards: LinesManifestShard[];
  /** Set after the legacy single-value key has been deleted. */
  legacyRemoved?: boolean;
}

export interface PackedShard {
  key: string;
  body: string;
  count: number;
  bytes: number;
  hash: string;
}

/** Two seeded FNV-1a passes: cheap and collision-safe enough for shard skipping. */
export function shardHash(body: string): string {
  let first = 2166136261;
  let second = 16777619;
  for (let index = 0; index < body.length; index += 1) {
    const code = body.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 16777619);
    second ^= code;
    second = Math.imul(second, 16777619);
  }
  return `${(first >>> 0).toString(16)}-${(second >>> 0).toString(16)}`;
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
    // Deliberately no generatedAt here: it made every shard differ on every
    // save, so the writer's etag/hash skip never worked and 8 puts were spent
    // even when no line changed. The manifest keeps the timestamp instead.
    const body = JSON.stringify({ lines: bucket });
    return { key: lineShardKey(index), body, count: bucket.length, bytes: encoder.encode(body).byteLength, hash: shardHash(body) };
  });
  const manifest: LinesManifest = {
    version: LINES_FORMAT_VERSION,
    generatedAt,
    total: lines.length,
    shardCount,
    shards: shards.map(({ key, count, bytes, hash }) => ({ key, count, bytes, hash })),
  };
  return { manifest, shards };
}

/**
 * Shards are written slimmed (empty tags/headers removed), so readers must
 * restore the shape the rest of the pipeline expects. `tags` in particular is
 * iterated unconditionally by dedupe/rules, and a missing array used to crash
 * publishing with "line.tags is not iterable".
 */
export function normalizeLine(line: LineEntry): LineEntry {
  const normalized = { ...line };
  if (!Array.isArray(normalized.tags)) normalized.tags = [];
  if (!normalized.headers || typeof normalized.headers !== 'object' || Array.isArray(normalized.headers)) {
    delete normalized.headers;
  }
  if (!Array.isArray(normalized.sourceIds)) delete normalized.sourceIds;
  return normalized;
}

export function parseLinesBody(text: string): LineEntry[] {
  try {
    const parsed = JSON.parse(text) as { lines?: LineEntry[] };
    return Array.isArray(parsed.lines) ? parsed.lines.map(normalizeLine) : [];
  } catch {
    return [];
  }
}

export function isGzipBytes(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}
