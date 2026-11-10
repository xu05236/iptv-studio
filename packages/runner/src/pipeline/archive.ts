import type { LineEntry } from '@iptv/core';

/**
 * lines.json grows with every discovered URL, even after the line has been
 * dead for months. Keeping every dead line forever is what pushes the artifact
 * toward the KV 25MB ceiling, so above this soft limit we move long-dead lines
 * into a separate archive file. Publishing is not blocked by this: the archive
 * is best-effort and the hard 20MB emergency trim below still applies.
 */
export const LINES_ARCHIVE_TRIGGER_BYTES = 12 * 1024 * 1024;
/**
 * 30 days = the line retention window. A dead line that has not recovered for
 * a full retention period is unlikely to come back; fold it into the archive
 * instead of letting lines.json climb toward the 22MB publish block.
 */
export const LINES_ARCHIVE_MIN_AGE_DAYS = 30;
export const LINES_ARCHIVE_MAX_LINES = 20_000;

export interface LinesArchive {
  generatedAt: string;
  lines: LineEntry[];
}

function stampOf(line: LineEntry): number {
  const value = line.lastProbeAt ?? line.rejectedAt ?? null;
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Dead lines older than `minAgeDays` are archived; a dead line that was never
 * probed (no timestamp at all) counts as old. Alive/suspect/pending lines are
 * never archived.
 */
export function splitArchivable(
  lines: LineEntry[],
  now: number,
  minAgeDays = LINES_ARCHIVE_MIN_AGE_DAYS,
): { keep: LineEntry[]; archived: LineEntry[] } {
  const cutoff = now - minAgeDays * 86_400_000;
  const keep: LineEntry[] = [];
  const archived: LineEntry[] = [];
  for (const line of lines) {
    if (line.status === 'dead' && stampOf(line) < cutoff) archived.push(line);
    else keep.push(line);
  }
  return { keep, archived };
}

/** Union by key, newest first, capped so the archive artifact stays small. */
export function mergeArchive(existing: LineEntry[], archived: LineEntry[], max = LINES_ARCHIVE_MAX_LINES): LineEntry[] {
  const seen = new Set<string>();
  const merged: LineEntry[] = [];
  for (const line of [...archived, ...existing]) {
    if (seen.has(line.key)) continue;
    seen.add(line.key);
    merged.push(line);
  }
  if (merged.length <= max) return merged;
  return merged.sort((a, b) => stampOf(b) - stampOf(a)).slice(0, max);
}
