import {
  inferResolution,
  isDueForProbe,
  mapPool,
  probeStream,
  qualityOf,
  qualityRank,
  scoreLine,
  sleep,
  transition,
  type AppSettings,
  type LineEntry,
  type ProbeResult,
  type ProbeTier,
} from '@iptv/core';
import type { SourceRecord } from '../store.js';
import type { RunLogger } from '../logger.js';

const UNPROBEABLE = /^(rtsp|rtmp|rtmps|rtsp|udp|rtp):\/\//i;
const MAX_INTERVAL_HOURS = 30 * 24;

/** Each successful recheck extends the interval by 3 days, capped at 30 days. */
function adaptiveHours(line: LineEntry, baseHours: number): number {
  const passes = Math.max(1, line.passCount ?? 1);
  return Math.min(MAX_INTERVAL_HOURS, baseHours + (passes - 1) * 3 * 24);
}

/** Heuristic used before spending a probe on a line. */
function preProbeRank(line: LineEntry, sources: Map<string, SourceRecord>): number {
  const source = sources.get(line.sourceId);
  const quality = qualityRank(qualityOf({ resolution: line.resolution ?? inferResolution(line.name), height: line.height }));
  const sourceReputation = source?.reputation ?? 50;
  const prior = Math.min(100, line.score ?? 0);
  const fresh = line.lastProbeAt ? 0 : 8;
  return fresh + quality * 10 + Math.min(30, sourceReputation / 4) + Math.min(20, prior / 5);
}

export function tierOf(source: SourceRecord | undefined): ProbeTier {
  return (source?.tier as ProbeTier) ?? 'normal';
}

/**
 * Choose what to probe today.
 *
 * Priority: never-probed lines first, then dead lines whose 14-day revival is
 * due, then everything that passed its tier TTL. A hard budget keeps a bad
 * source from eating the whole run.
 */
export function planProbes(
  lines: LineEntry[],
  sources: Map<string, SourceRecord>,
  settings: AppSettings,
  budget: number,
  now = new Date(),
  force = false,
  premiumKeys?: Set<string>,
): LineEntry[] {
  const premiumHours = Math.max(1, settings.probePremiumHours || 168);
  const aliveHours = Math.max(1, settings.probeAliveHours || 360);
  const perChannelCap = Math.max(1, settings.probePerChannel || 24);
  const candidates = lines.filter((line) => {
    if (UNPROBEABLE.test(line.url)) return false;
    if (line.status === 'dead' && line.failCount >= 5) return false;

    if (line.status === 'alive') {
      const baseHours = premiumKeys?.has(line.key) ? premiumHours : aliveHours;
      const interval = adaptiveHours(line, baseHours);
      if (!force && line.lastProbeAt && now.getTime() - new Date(line.lastProbeAt).getTime() < interval * 60 * 60 * 1000) {
        return false;
      }
      return true;
    }

    return force || isDueForProbe(line, tierOf(sources.get(line.sourceId)), now);
  });

  const weight = (line: LineEntry): number => {
    if (!line.lastProbeAt) return 0;
    if (line.status === 'suspect') return 1;
    if (line.status === 'alive') return 2;
    // New lines beat dead-line revival: dead lines rarely come back, and new
    // channels are what the daily run is trying to discover.
    if (line.status === 'dead') return 4;
    return 3;
  };

  // Quality-first pre-filter: for a channel with 100 candidates only the best
  // 16 (by resolution, source reputation, prior score and freshness) are
  // allowed into this round. The rest stay in state and rotate in later.
  const grouped = new Map<string, LineEntry[]>();
  for (const line of candidates) {
    const list = grouped.get(line.channelId) ?? [];
    list.push(line);
    grouped.set(line.channelId, list);
  }
  const selected: LineEntry[] = [];
  for (const list of grouped.values()) {
    list.sort((a, b) => preProbeRank(b, sources) - preProbeRank(a, sources));
    selected.push(...list.slice(0, force ? list.length : perChannelCap));
  }
  selected.sort((a, b) => weight(a) - weight(b) || preProbeRank(b, sources) - preProbeRank(a, sources));

  return selected.slice(0, Math.max(0, budget));
}

export interface ProbeSummary {
  probed: number;
  alive: number;
  dead: number;
  suspect: number;
  bytes: number;
  skipped: number;
  errors: Array<{ url: string; error: string }>;
}

/** Probe the selected lines and mutate them in place (status/score/history). */
export async function runProbes(
  lines: LineEntry[],
  settings: AppSettings,
  concurrency: number,
  logger: RunLogger,
  onProgress?: (done: number) => void,
): Promise<ProbeSummary> {
  const summary: ProbeSummary = { probed: 0, alive: 0, dead: 0, suspect: 0, bytes: 0, skipped: 0, errors: [] };
  const nowIso = new Date().toISOString();
  let done = 0;

  await mapPool(lines, Math.max(1, Math.min(concurrency, 128)), async (line) => {
    const wasAlive = line.status === 'alive';
    let result = await probeOnce(line, settings, nowIso);
    // A single transient timeout must not demote a line that has been stable.
    if (!result.ok && wasAlive && line.failCount === 0) {
      await sleep(700);
      const retry = await probeOnce(line, settings, nowIso);
      if (retry.ok) result = retry;
    }

    const next = transition(line, result, { reviveDays: settings.deadReviveDays });
    if (next.skipped) {
      summary.skipped++;
    } else {
      line.status = next.status;
      line.failCount = next.failCount;
      line.passCount = next.passCount;
      line.reviveAt = next.reviveAt;
      line.lastProbeAt = result.checkedAt;
      summary.probed++;
      if (next.status === 'alive') summary.alive++;
      else if (next.status === 'dead') summary.dead++;
      else summary.suspect++;
    }

    if (result.ok) {
      line.protocol = result.protocol;
      line.speedKbps = result.speedKbps;
      line.latencyMs = result.ttfbMs;
      line.resolution = result.resolution ?? line.resolution;
      line.width = result.width;
      line.height = result.height;
      line.frameRate = result.frameRate;
      line.bandwidthKbps = result.bandwidthKbps;
      line.codecs = result.codecs ?? line.codecs;
      line.loop = result.loop;
      line.error = undefined;
    } else {
      line.error = result.error?.slice(0, 200);
      if (next.status === 'dead') line.speedKbps = 0;
    }

    summary.bytes += result.bytes ?? 0;
    if (!result.ok && summary.errors.length < 20 && result.error) {
      summary.errors.push({ url: line.url, error: result.error });
    }

    line.score = scoreLine(line, Date.now());
    done++;
    if (done % 200 === 0) {
      logger.info('探测进度', { done, total: lines.length, alive: summary.alive, dead: summary.dead });
      onProgress?.(done);
    }
  });

  return summary;
}

async function probeOnce(line: LineEntry, settings: AppSettings, checkedAt: string): Promise<ProbeResult> {
  try {
    return await probeStream(line.url, {
      headers: line.headers,
      timeoutMs: settings.probeTimeoutMs,
      warmupBytes: settings.warmupBytes,
      sampleMs: settings.sampleMs,
      maxBytes: 2_500_000,
    });
  } catch (error) {
    return {
      ok: false,
      protocol: line.protocol,
      error: error instanceof Error ? error.message : String(error),
      checkedAt,
    };
  }
}
