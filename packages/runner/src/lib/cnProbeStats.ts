import { countCnCandidates, CN_PROBE_STATS_KEY, type CnProbeStats, type LineEntry } from '@iptv/core';
import type { ArtifactStore } from '../store.js';

/**
 * Refresh the task board's "国内补测" counter. Only writes when the number (or
 * batch size) changes, so idle cn-probe runs cost no KV writes.
 */
export async function writeCnProbeStats(store: ArtifactStore, lines: LineEntry[], batchSize: number): Promise<void> {
  try {
    const { eligible, outstanding } = countCnCandidates(lines);
    const previous = await store.getJson<CnProbeStats>(CN_PROBE_STATS_KEY).catch(() => null);
    if (previous && previous.eligible === eligible && previous.outstanding === outstanding && previous.batchSize === batchSize) return;
    const next: CnProbeStats = { generatedAt: new Date().toISOString(), eligible, outstanding, batchSize };
    await store.put(CN_PROBE_STATS_KEY, JSON.stringify(next), 'application/json');
  } catch {
    // Diagnostics only: never fail a publish/probe because of this counter.
  }
}
