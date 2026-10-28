import {
  isDueForProbe,
  mapPool,
  probeStream,
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
): LineEntry[] {
  const candidates = lines.filter((line) => {
    if (UNPROBEABLE.test(line.url)) return false;
    if (line.status === 'dead' && line.failCount >= 5) return false;
    return force || isDueForProbe(line, tierOf(sources.get(line.sourceId)), now);
  });

  const weight = (line: LineEntry): number => {
    if (!line.lastProbeAt) return 0;
    if (line.status === 'dead') return 1;
    if (line.status === 'suspect') return 2;
    return 3;
  };

  candidates.sort((a, b) => {
    const byWeight = weight(a) - weight(b);
    if (byWeight !== 0) return byWeight;
    // within a bucket prefer lines that have never worked over ones that already failed
    return (a.failCount ?? 0) - (b.failCount ?? 0);
  });

  return candidates.slice(0, Math.max(0, budget));
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
      line.reviveAt = next.reviveAt;
      line.lastProbeAt = result.checkedAt;
      summary.probed++;
      if (next.status === 'alive') summary.alive++;
      else if (next.status === 'dead') summary.dead++;
      else summary.suspect++;
    }

    if (result.ok) {
      line.speedKbps = result.speedKbps;
      line.latencyMs = result.ttfbMs;
      line.resolution = result.resolution ?? line.resolution;
      line.width = result.width;
      line.height = result.height;
      line.frameRate = result.frameRate;
      line.bandwidthKbps = result.bandwidthKbps;
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
