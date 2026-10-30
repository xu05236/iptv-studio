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

/** Canonical form used to dedupe/tombstone a stream across source variants. */
export function canonicalPoolUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith('//')) return `http:${trimmed}`;
  return trimmed;
}

/**
 * The same stream is often advertised by several sources. State keeps one row
 * per source, and their urlKey formats disagree (`//host/path` vs `http://…`),
 * so collapse by a canonical URL and keep the most useful record: alive first,
 * then the most recently probed.
 */
export function dedupePoolLines(lines: LineEntry[]): LineEntry[] {
  const rank: Record<string, number> = { alive: 3, suspect: 2, unknown: 1, dead: 0 };
  const best = new Map<string, LineEntry>();
  for (const line of lines) {
    const key = canonicalPoolUrl(line.url);
    const current = best.get(key);
    if (!current) {
      best.set(key, line);
      continue;
    }
    const lineRank = rank[line.status] ?? 0;
    const currentRank = rank[current.status] ?? 0;
    if (lineRank !== currentRank) {
      if (lineRank > currentRank) best.set(key, line);
      continue;
    }
    const lineProbe = line.lastProbeAt ?? '';
    const currentProbe = current.lastProbeAt ?? '';
    if (lineProbe !== currentProbe) {
      if (lineProbe > currentProbe) best.set(key, line);
      continue;
    }
    if ((line.score ?? 0) > (current.score ?? 0)) best.set(key, line);
  }
  return [...best.values()];
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

  for (const line of dedupePoolLines(input.lines)) {
    if (!channelMap.has(line.channelId)) continue;
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
      // A line without a probe timestamp was never tested; the pool treats it
      // as pending, so it must not leak into premium/backup either.
      if (!line.lastProbeAt) continue;
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
