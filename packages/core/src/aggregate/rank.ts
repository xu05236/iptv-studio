import type { LineEntry, Quality, SourceConfig } from '../types.js';
import { qualityFromResolution } from '../probe/measure.js';

const QUALITY_SCORE: Record<Quality, number> = {
  '2160p': 1,
  '1440p': 0.88,
  '1080p': 0.72,
  '720p': 0.52,
  '480p': 0.3,
  sd: 0.2,
  unknown: 0.35,
};

export function qualityOf(line: Pick<LineEntry, 'resolution' | 'height'>): Quality {
  if (line.height) return qualityFromResolution(`${line.height}`);
  return qualityFromResolution(line.resolution);
}

/** 100 kbit/s -> 0, 8 Mbit/s -> 1, logarithmic so 1→2 Mbit/s matters less than 0.2→0.4. */
function speedScore(kbps?: number): number {
  if (!kbps || kbps <= 0) return 0;
  const value = Math.log10(Math.max(kbps, 100) / 100) / Math.log10(80);
  return Math.max(0, Math.min(1, value));
}

function freshnessScore(lastProbeAt?: string, now = Date.now()): number {
  if (!lastProbeAt) return 0.3;
  const ageDays = (now - new Date(lastProbeAt).getTime()) / 86_400_000;
  if (ageDays <= 1) return 1;
  if (ageDays <= 3) return 0.85;
  if (ageDays <= 7) return 0.65;
  if (ageDays <= 14) return 0.45;
  return 0.3;
}

export interface ScoreInput {
  speedKbps?: number;
  latencyMs?: number;
  resolution?: string;
  height?: number;
  status: string;
  failCount: number;
  loop?: boolean;
  protocol: string;
  lastProbeAt?: string;
  sourceReputation?: number;
}

/**
 * 0-100 quality score used for ranking lines inside a channel.
 * Speed dominates, but a stable 1080p line beats a flapping 4K one.
 */
export function scoreLine(input: ScoreInput, now = Date.now()): number {
  if (input.status === 'dead') return 0;

  const quality = QUALITY_SCORE[qualityOf(input)];
  const reliability = 1 - Math.min(3, Math.max(0, input.failCount)) / 3;
  const reputation = Math.max(0, Math.min(1, (input.sourceReputation ?? 50) / 100));
  const protocol = input.protocol === 'hls' ? 1 : input.protocol === 'http' ? 0.9 : 0.7;
  const freshness = freshnessScore(input.lastProbeAt, now);
  const latency = input.latencyMs && input.latencyMs > 0
    ? 1 - Math.min(1, input.latencyMs / 2_000)
    : 0.5;
  const loopPenalty = input.loop ? 0.55 : 1;

  const raw =
    0.36 * speedScore(input.speedKbps) +
    0.08 * latency +
    0.22 * quality +
    0.14 * reliability +
    0.10 * reputation +
    0.06 * protocol +
    0.04 * freshness;

  return Math.round(Math.max(0, Math.min(100, raw * 100 * loopPenalty)) * 10) / 10;
}

export function sourceReputationMap(sources: Array<Pick<SourceConfig, 'id' | 'reputation' | 'weight'>>): Map<string, number> {
  return new Map(sources.map((source) => [source.id, Math.min(100, source.reputation * (source.weight || 1))]));
}

export function compareLines(a: LineEntry, b: LineEntry): number {
  // 官方保底线路永远排在最前。
  if (Boolean(a.official) !== Boolean(b.official)) return a.official ? -1 : 1;
  if (a.favorite !== b.favorite) return b.favorite ? 1 : -1;
  if (a.status === 'alive' && b.status !== 'alive') return -1;
  if (b.status === 'alive' && a.status !== 'alive') return 1;
  if (b.score !== a.score) return b.score - a.score;
  const speed = (b.speedKbps ?? 0) - (a.speedKbps ?? 0);
  if (speed !== 0) return speed;
  return (b.lastProbeAt ?? '').localeCompare(a.lastProbeAt ?? '');
}

/** Region/operator suffix, e.g. `CCTV-1 综合 (-江苏电信)`. */
export function regionSuffix(line: Pick<LineEntry, 'region' | 'operator'>): string {
  const parts = [line.region, line.operator].filter(Boolean) as string[];
  if (!parts.length) return '';
  return `（-${parts.join('')}）`;
}
