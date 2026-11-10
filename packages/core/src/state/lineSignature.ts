import type { LineEntry } from '../types.js';

type HeaderMap = NonNullable<LineEntry['headers']>;

/**
 * Two lines that share the same URL but send different request headers are
 * different playback targets, so the signature includes the headers.
 */
export function headerKey(headers?: HeaderMap | null): string {
  if (!headers) return '';
  const map = headers as Record<string, string>;
  return Object.keys(map)
    .sort()
    .map((key) => `${key.toLowerCase()}:${map[key]}`)
    .join('\n');
}

export function lineSignature(line: Pick<LineEntry, 'urlKey' | 'headers'>): string {
  return `${line.urlKey}\u0001${headerKey(line.headers)}`;
}

/**
 * When several sources publish the same URL, keep one copy.
 * Prefer the earliest non-dead line; fall back to the earliest dead one so a
 * takeover can replace it with a fresh line from another source.
 */
export function pickDuplicateOwner<T extends { status: string; firstSeenAt: string }>(lines: T[]): T | null {
  if (!lines.length) return null;
  const healthy = lines.filter((line) => line.status !== 'dead');
  const pool = healthy.length ? healthy : lines;
  return pool.slice().sort((a, b) => (a.firstSeenAt < b.firstSeenAt ? -1 : a.firstSeenAt > b.firstSeenAt ? 1 : 0))[0] ?? null;
}
