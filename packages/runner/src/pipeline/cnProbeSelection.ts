import { lineSignature, type LineEntry } from '@iptv/core';

export interface CnProbeSelectionOptions {
  limit: number;
  /** Hard cap per source, default 25% of the batch. */
  perSourceCap?: number;
  now?: number;
  cooldownMs?: number;
}

const DAY_MS = 24 * 3_600_000;

function comparePriority(left: LineEntry, right: LineEntry): number {
  if (left.status !== right.status) return left.status === 'dead' ? -1 : 1;
  return (Date.parse(right.lastProbeAt ?? '2020-01-01') || 0) - (Date.parse(left.lastProbeAt ?? '2020-01-01') || 0);
}

/**
 * Pick domestic-only retry candidates.
 *
 * Priority is still "fresh breakage first": dead before suspect, newest probe
 * first, because a line that just failed is more likely to be a domestic-only
 * stream. The result is then spread across sources. Without the spread, one
 * source with thousands of dead lines fills every batch and other sources are
 * never retried (observed with CCSH-IPTV: four batches in a row, all 200 lines
 * from that source while five other sources had hundreds of candidates).
 */
export function selectCnProbeLines(lines: LineEntry[], options: CnProbeSelectionOptions): LineEntry[] {
  const limit = Math.max(1, Math.floor(options.limit));
  const now = options.now ?? Date.now();
  const cooldownMs = options.cooldownMs ?? DAY_MS;
  const cap = Math.max(1, Math.floor(options.perSourceCap ?? Math.ceil(limit * 0.25)));

  const eligible = lines.filter(
    (line) =>
      (line.status === 'dead' || line.status === 'suspect') &&
      line.cnReachable !== true &&
      (!line.cnCheckedAt || now - Date.parse(line.cnCheckedAt) > cooldownMs),
  );
  eligible.sort(comparePriority);

  // The same URL + headers is one playback target; retrying every source copy
  // only burns the domestic proxy without extra information.
  const seen = new Set<string>();
  const unique = eligible.filter((line) => {
    const signature = lineSignature(line);
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });

  const queues: LineEntry[][] = [];
  const bySource = new Map<string, LineEntry[]>();
  for (const line of unique) {
    let queue = bySource.get(line.sourceId);
    if (!queue) {
      queue = [];
      bySource.set(line.sourceId, queue);
      queues.push(queue);
    }
    queue.push(line);
  }

  const picked: LineEntry[] = [];
  const used = new Map<LineEntry[], number>();
  let progressed = true;
  while (picked.length < limit && progressed) {
    progressed = false;
    for (const queue of queues) {
      if (picked.length >= limit) break;
      const count = used.get(queue) ?? 0;
      if (count >= cap || !queue.length) continue;
      picked.push(queue.shift()!);
      used.set(queue, count + 1);
      progressed = true;
    }
  }
  // A small number of sources plus the 25% cap can leave the batch half-empty.
  // Keep the round-robin order but drop the cap so the batch still fills.
  let added = true;
  while (picked.length < limit && added) {
    added = false;
    for (const queue of queues) {
      if (picked.length >= limit) break;
      const line = queue.shift();
      if (!line) continue;
      picked.push(line);
      added = true;
    }
  }
  return picked;
}

export function describeSourceCoverage(lines: LineEntry[]): Array<{ sourceId: string; count: number }> {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line.sourceId, (counts.get(line.sourceId) ?? 0) + 1);
  return [...counts.entries()].map(([sourceId, count]) => ({ sourceId, count })).sort((a, b) => b.count - a.count);
}
