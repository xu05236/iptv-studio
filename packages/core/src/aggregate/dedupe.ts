import type { LineEntry } from '../types.js';
import { compareLines } from './rank.js';

/**
 * Two subscriptions usually list the same CCTV-1 feed. Dedupe is therefore
 * channel-scoped, not source-scoped: the same URL for the same channel keeps a
 * single line, and the best scoring source wins the attribution.
 */
export function dedupeLines(lines: LineEntry[]): LineEntry[] {
  const byKey = new Map<string, LineEntry>();

  for (const line of lines) {
    const key = `${line.channelId}\u0001${line.urlKey || line.url}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...line, tags: [...(line.tags ?? [])] });
      continue;
    }
    const winner = compareLines(existing, line) <= 0 ? existing : line;
    const loser = winner === existing ? line : existing;
    byKey.set(key, {
      ...winner,
      sourceIds: [...new Set([...(existing.sourceIds ?? [existing.sourceId]), ...(line.sourceIds ?? [line.sourceId])])],
      firstSeenAt: earliest(existing.firstSeenAt, line.firstSeenAt),
      lastSeenAt: latest(existing.lastSeenAt, line.lastSeenAt) ?? winner.lastSeenAt,
      lastProbeAt: latest(existing.lastProbeAt, line.lastProbeAt),
      tags: [...new Set([...(existing.tags ?? []), ...(line.tags ?? [])])].sort(),
      // preserve the better measurement even if attribution came from the loser
      speedKbps: winner.speedKbps ?? loser.speedKbps,
      resolution: winner.resolution ?? loser.resolution,
    });
  }

  return [...byKey.values()];
}

function earliest(a: string | undefined, b: string | undefined): string {
  if (!a) return b ?? '';
  if (!b) return a;
  return a < b ? a : b;
}

function latest(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/** Cap how many lines a single source may contribute to one channel. */
export function capPerSource(lines: LineEntry[], maxPerSource: number): LineEntry[] {
  if (maxPerSource <= 0) return lines;
  const counts = new Map<string, number>();
  const out: LineEntry[] = [];
  for (const line of lines) {
    const used = counts.get(line.sourceId) ?? 0;
    if (used >= maxPerSource) continue;
    counts.set(line.sourceId, used + 1);
    out.push(line);
  }
  return out;
}

/** Split lines into alive / suspect / dead buckets without losing ordering. */
export function partitionLines(lines: LineEntry[]): { alive: LineEntry[]; suspect: LineEntry[]; dead: LineEntry[]; unknown: LineEntry[] } {
  const alive: LineEntry[] = [];
  const suspect: LineEntry[] = [];
  const dead: LineEntry[] = [];
  const unknown: LineEntry[] = [];
  for (const line of lines) {
    if (line.status === 'alive') alive.push(line);
    else if (line.status === 'suspect') suspect.push(line);
    else if (line.status === 'dead') dead.push(line);
    else unknown.push(line);
  }
  return { alive, suspect, dead, unknown };
}
