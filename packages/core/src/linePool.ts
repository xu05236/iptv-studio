import { compareLines } from './aggregate/rank.js';
import type { LineEntry } from './types.js';

/** Lifecycle buckets used by the line pool. */
export type PoolName = 'premium' | 'backup' | 'candidate' | 'pending' | 'quarantine' | 'rejected';

export interface PoolChannelMeta {
  id: string;
  name: string;
  group: string;
  tvgId?: string | null;
  logo?: string | null;
}

export interface PoolSnapshotChannel {
  channel: PoolChannelMeta;
  /** Quality-confirmed alive lines, ranked, within the per-channel target. */
  premium: LineEntry[];
  /** Quality-confirmed alive lines past the target. */
  backup: LineEntry[];
  /** Alive but quality (resolution) not confirmed yet — never exported by default. */
  candidate: LineEntry[];
}

export interface PoolSnapshot {
  generatedAt: string;
  channels: Record<string, PoolSnapshotChannel>;
}

/** An alive line only counts as premium/backup once we know its resolution. */
export function qualityConfirmed(line: Pick<LineEntry, 'resolution' | 'height'>): boolean {
  if (line.height && line.height > 0) return true;
  return Boolean(line.resolution && !/unknown/i.test(line.resolution));
}

export interface BuildPoolSnapshotInput {
  lines: LineEntry[];
  channels: PoolChannelMeta[];
  maxLinesPerChannel: number;
  generatedAt: string;
}

/**
 * Build the pool snapshot consumed by subscription rendering. It only keeps
 * tested-alive lines: pending/suspect/dead lines cannot be subscribed, and
 * URL duplicates are collapsed so one stream never appears twice.
 */
export function buildPoolSnapshot(input: BuildPoolSnapshotInput): PoolSnapshot {
  const channelMap = new Map(input.channels.map((channel) => [channel.id, channel]));
  const byChannel = new Map<string, LineEntry[]>();
  const seenUrls = new Set<string>();

  for (const line of input.lines) {
    if (!channelMap.has(line.channelId)) continue;
    if (seenUrls.has(line.urlKey)) continue;
    seenUrls.add(line.urlKey);
    const list = byChannel.get(line.channelId) ?? [];
    list.push(line);
    byChannel.set(line.channelId, list);
  }

  const target = Math.max(1, Math.min(12, input.maxLinesPerChannel * 2));
  const channels: Record<string, PoolSnapshotChannel> = {};

  for (const [channelId, lines] of byChannel) {
    const channel = channelMap.get(channelId);
    if (!channel) continue;
    lines.sort(compareLines);
    const premium: LineEntry[] = [];
    const backup: LineEntry[] = [];
    const candidate: LineEntry[] = [];
    for (const line of lines) {
      if (line.status !== 'alive') continue;
      if (!qualityConfirmed(line)) {
        candidate.push(line);
        continue;
      }
      if (premium.length < target) premium.push(line);
      else backup.push(line);
    }
    if (premium.length || backup.length || candidate.length) {
      channels[channelId] = { channel, premium, backup, candidate };
    }
  }

  return { generatedAt: input.generatedAt, channels };
}

/** Resolve the final pool of a snapshot line, letting manual overrides win. */
export function resolvePool(
  autoPool: Exclude<PoolName, 'pending' | 'quarantine' | 'rejected'>,
  override: string | null | undefined,
): PoolName {
  return (override as PoolName | undefined) ?? autoPool;
}
