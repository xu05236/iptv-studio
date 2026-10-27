/** Small, dependency-free hashing helpers (stable across runtimes). */

export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 53-bit-ish hash built from two independent FNV rounds, rendered base36. */
export function hashId(input: string, length = 10): string {
  const a = fnv1a32(input);
  const b = fnv1a32(`${input}:${a.toString(36)}`);
  const raw = (BigInt(a) << 21n) | BigInt(b & 0x1fffff);
  return raw.toString(36).padStart(length, '0').slice(-length);
}

export function stableKey(parts: Array<string | number | boolean | null | undefined>): string {
  return parts.map((part) => (part === null || part === undefined ? '' : String(part))).join('\u0001');
}

export function entryKey(sourceId: string, urlKey: string): string {
  return hashId(`${sourceId}\u0001${urlKey}`, 12);
}

/**
 * Stable bucket index for sharded storage. Both the runner (writing) and the
 * Worker (reading) must agree, so it lives in core.
 */
export function bucketOf(id: string, buckets = 64): number {
  return fnv1a32(id) % Math.max(1, buckets);
}

/** Deterministic JSON stringify so object key order never creates false diffs. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}
