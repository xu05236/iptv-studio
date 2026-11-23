import { lineSignature } from './lineSignature.js';
import type { LineEntry } from '../types.js';

/** Small artifact the task board reads instead of parsing every line. */
export const CN_PROBE_STATS_KEY = 'state/cn-probe-stats.json';
export const CN_PROBE_COOLDOWN_MS = 24 * 3_600_000;

export interface CnProbeStats {
  generatedAt: string;
  /** Lines that can be picked by the next batch (24h cooldown applied). */
  eligible: number;
  /** All dead/suspect lines not yet reachable via a domestic proxy, cooldown ignored. */
  outstanding: number;
  batchSize: number;
}

/**
 * Keep this in sync with the runner's cn-probe selection
 * (`packages/runner/src/cli.ts`): dead/suspect, not already reachable via a
 * domestic proxy, deduped by URL + headers. `eligible` additionally applies
 * the 24h cooldown that the batch selection enforces.
 */
export function countCnCandidates(lines: LineEntry[], now = Date.now()): { eligible: number; outstanding: number } {
  const seen = new Set<string>();
  let eligible = 0;
  let outstanding = 0;
  for (const line of lines) {
    if (line.status !== 'dead' && line.status !== 'suspect') continue;
    if (line.cnReachable === true) continue;
    const signature = lineSignature(line);
    if (seen.has(signature)) continue;
    seen.add(signature);
    outstanding += 1;
    const coolingDown = Boolean(line.cnCheckedAt) && now - Date.parse(line.cnCheckedAt!) <= CN_PROBE_COOLDOWN_MS;
    if (!coolingDown) eligible += 1;
  }
  return { eligible, outstanding };
}
