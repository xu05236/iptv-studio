import type { ChannelCatalogEntry, ChannelConfig, LineEntry, Protocol, Quality } from '../types.js';
import { capPerSource, dedupeLines, partitionLines } from './dedupe.js';
import { compareLines, qualityOf } from './rank.js';
import { shouldExport } from './state.js';

const QUALITY_RANK: Record<Quality, number> = {
  unknown: -1,
  sd: 0,
  '480p': 1,
  '720p': 2,
  '1080p': 3,
  '1440p': 4,
  '2160p': 5,
};

export function qualityRank(quality: Quality | string): number {
  return QUALITY_RANK[quality as Quality] ?? -1;
}

export interface SelectOptions {
  maxLines: number;
  maxPerSource: number;
  minQuality: Quality | 'any';
  minSpeedKbps: number;
  protocols?: Protocol[];
  compensate: boolean;
  keepSuspect: boolean;
  /** Drop lines far below the best quality/speed in the same channel. */
  relativeFloor?: boolean;
}

/** Choose the lines that go into a playlist for one channel. */
export function selectLines(lines: LineEntry[], options: SelectOptions): LineEntry[] {
  const sorted = [...lines].sort(compareLines);
  const aliveCount = sorted.filter((line) => line.status === 'alive').length;
  const eligible = sorted.filter((line) => shouldExport(line, aliveCount, options));

  const passes = (line: LineEntry): boolean => {
    if (options.minQuality !== 'any' && qualityRank(qualityOf(line)) < qualityRank(options.minQuality)) return false;
    if (options.minSpeedKbps > 0 && (line.speedKbps ?? 0) < options.minSpeedKbps) return false;
    if (options.protocols?.length && !options.protocols.includes(line.protocol)) return false;
    return true;
  };

  let picked = eligible.filter(passes);
  // Filters must never produce an empty channel when compensation is enabled.
  if (!picked.length && options.compensate) picked = eligible;

  if (options.relativeFloor !== false && picked.length > 1) {
    const alive = picked.filter((line) => line.status === 'alive');
    const bestQuality = Math.max(-1, ...alive.map((line) => qualityRank(qualityOf(line))));
    const bestSpeed = Math.max(0, ...alive.map((line) => line.speedKbps ?? 0));
    if (alive.length > 1) {
      const floored = picked.filter((line) => {
        if (line.status !== 'alive') return true;
        if (bestQuality >= 0 && qualityRank(qualityOf(line)) < Math.max(0, bestQuality - 2)) return false;
        if (bestSpeed > 0 && (line.speedKbps ?? 0) < bestSpeed * 0.25) return false;
        return true;
      });
      if (floored.length) picked = floored;
    }
  }

  const capped = capPerSource(picked, options.maxPerSource);
  return options.maxLines > 0 ? capped.slice(0, options.maxLines) : capped;
}

/**
 * Merge every line of a channel, dedupe it and keep a bounded, score-sorted
 * history (dead lines included so the admin can see what disappeared).
 */
export function aggregateChannel(
  channel: ChannelConfig,
  lines: LineEntry[],
  options: { maxCatalogLines?: number },
): ChannelCatalogEntry {
  const deduped = dedupeLines(lines.filter((line) => line.channelId === channel.id));
  deduped.sort(compareLines);
  const limit = options.maxCatalogLines ?? 40;
  return {
    channel,
    lines: limit > 0 ? deduped.slice(0, limit) : deduped,
  };
}

export interface ChannelStats {
  lines: number;
  alive: number;
  suspect: number;
  dead: number;
  bestSpeedKbps: number;
  bestQuality: Quality;
  sources: number;
}

export function channelStats(lines: LineEntry[]): ChannelStats {
  const { alive, suspect, dead } = partitionLines(lines);
  let bestSpeedKbps = 0;
  let bestQuality: Quality = 'unknown';
  for (const line of alive) {
    if ((line.speedKbps ?? 0) > bestSpeedKbps) bestSpeedKbps = line.speedKbps ?? 0;
    const quality = qualityOf(line);
    if (qualityRank(quality) > qualityRank(bestQuality)) bestQuality = quality;
  }
  return {
    lines: lines.length,
    alive: alive.length,
    suspect: suspect.length,
    dead: dead.length,
    bestSpeedKbps,
    bestQuality,
    sources: new Set(lines.flatMap((line) => line.sourceIds ?? [line.sourceId])).size,
  };
}
