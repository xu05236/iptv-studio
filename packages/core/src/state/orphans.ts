import type { LineEntry } from '../types.js';

export interface OrphanPruneInput {
  channelIds: Iterable<string>;
  sourceIds: Iterable<string>;
}

export interface OrphanPruneResult {
  lines: LineEntry[];
  removed: number;
  /** Non-alive lines dropped because their channel record is missing. */
  missingChannel: number;
  /** Non-alive lines dropped because their source record is missing. */
  missingSource: number;
  /** Orphan lines kept because they are still usable (alive). */
  keptAlive: number;
}

/**
 * Remove lines whose channel or source no longer exists, while always keeping
 * usable (alive) lines: a deleted mirror can still leave playable URLs behind
 * and the operator asked us not to throw those away.
 *
 * `x-` channel ids are exempt from the channel check: they are created during
 * publish from source names, so a brand-new channel has no record yet.
 */
export function pruneOrphanLines(input: OrphanPruneInput, lines: LineEntry[]): OrphanPruneResult {
  const channelIds = new Set(input.channelIds);
  const sourceIds = new Set(input.sourceIds);
  const kept: LineEntry[] = [];
  let missingChannel = 0;
  let missingSource = 0;
  let keptAlive = 0;

  for (const line of lines) {
    const channelMissing = !channelIds.has(line.channelId) && !line.channelId.startsWith('x-');
    const sourceMissing = !sourceIds.has(line.sourceId);
    if (!channelMissing && !sourceMissing) {
      kept.push(line);
      continue;
    }
    if (line.status === 'alive') {
      keptAlive += 1;
      kept.push(line);
      continue;
    }
    if (channelMissing) missingChannel += 1;
    if (sourceMissing) missingSource += 1;
  }

  return { lines: kept, removed: lines.length - kept.length, missingChannel, missingSource, keptAlive };
}
