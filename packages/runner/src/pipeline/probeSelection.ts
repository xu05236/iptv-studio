import { compareLines, lineSignature, type LineEntry } from '@iptv/core';

/** Merged channels aggregate a whole platform, so they need a much larger batch allowance. */
export const MERGED_PROBE_PER_CHANNEL = 200;

export interface ProbeSelectionOptions {
  matches: (line: LineEntry) => boolean;
  channelIds: Set<string>;
  favorites: Set<string>;
  cooldown: Map<string, number>;
  takenSignatures: Set<string>;
  now: number;
  perChannel: number;
  mergedPerChannel?: number;
  limit: number;
}

/**
 * Pick probe targets breadth-first: every channel gets a turn before any channel
 * takes a second line. Within a channel: favorite source, oldest probe, score.
 * Orders rotate by hour so consecutive batches start from different channels.
 * URL signatures are deduped and the prefilter cooldown is respected.
 */
export function selectProbeLines(lines: LineEntry[], options: ProbeSelectionOptions): LineEntry[] {
  const mergedCap = Math.max(options.perChannel, options.mergedPerChannel ?? MERGED_PROBE_PER_CHANNEL);
  const favoriteRank = (line: LineEntry): number => (options.favorites.has(line.sourceId) ? 0 : 1);
  const probedAt = (line: LineEntry): number => Date.parse(line.lastProbeAt ?? '') || 0;
  const capOf = (channelId: string): number => (channelId.startsWith('x-mc-') ? mergedCap : options.perChannel);

  const byChannel = new Map<string, LineEntry[]>();
  for (const line of lines) {
    if (!options.channelIds.has(line.channelId)) continue;
    if (!options.matches(line)) continue;
    const bucket = byChannel.get(line.channelId) ?? [];
    bucket.push(line);
    byChannel.set(line.channelId, bucket);
  }

  const buckets: Array<{ channelId: string; lines: LineEntry[] }> = [];
  for (const [channelId, bucket] of byChannel) {
    bucket.sort(
      (a, b) => favoriteRank(a) - favoriteRank(b) || probedAt(a) - probedAt(b) || compareLines(a, b),
    );
    buckets.push({ channelId, lines: bucket.slice(0, capOf(channelId)) });
  }

  const hashRank = (value: string): number => {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) | 0;
    return ((hash % 997) + 997) % 997;
  };
  const hourSeed = Math.floor(options.now / 3_600_000);
  const oldest = (bucket: { lines: LineEntry[] }): number =>
    bucket.lines.reduce((min, line) => Math.min(min, probedAt(line) || Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);

  buckets.sort((left, right) => {
    const favorite = favoriteRank(left.lines[0]!) - favoriteRank(right.lines[0]!);
    if (favorite !== 0) return favorite;
    const age = oldest(left) - oldest(right);
    if (age !== 0) return age;
    const rotation = (hashRank(left.channelId) + hourSeed) % 997 - ((hashRank(right.channelId) + hourSeed) % 997);
    if (rotation !== 0) return rotation;
    return left.channelId.localeCompare(right.channelId);
  });

  const cursors = buckets.map(() => 0);
  const picked: LineEntry[] = [];
  while (picked.length < options.limit) {
    let progressed = false;
    for (let index = 0; index < buckets.length && picked.length < options.limit; index += 1) {
      const bucket = buckets[index]!;
      while (cursors[index]! < bucket.lines.length) {
        const line = bucket.lines[cursors[index]!]!;
        cursors[index] = cursors[index]! + 1;
        if (line.official) continue;
        const signature = lineSignature(line);
        if (options.takenSignatures.has(signature)) continue;
        if ((options.cooldown.get(signature) ?? 0) > options.now) continue;
        options.takenSignatures.add(signature);
        picked.push(line);
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  return picked;
}
