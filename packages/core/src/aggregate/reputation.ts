import type { SourceConfig } from '../types.js';

export interface ReputationInput {
  previous: number;
  alive: number;
  total: number;
  avgScore: number;
  fetchOk: boolean;
  consecutiveFailures: number;
}

/**
 * Source reputation = long-run availability + average line quality.
 * It feeds (a) probe frequency, (b) ranking weight, (c) the "全灭的源降权"
 * behaviour: a source that suddenly returns nothing loses trust slowly rather
 * than being deleted, so a bad day at the upstream does not kill it.
 */
export function nextReputation(input: ReputationInput): number {
  const availability = input.total > 0 ? input.alive / input.total : 0;
  const quality = Math.max(0, Math.min(1, input.avgScore / 100));
  let target = 100 * (0.72 * availability + 0.28 * quality);
  if (!input.fetchOk) target *= 0.45;

  const previous = Number.isFinite(input.previous) ? input.previous : 50;
  let next = previous * 0.65 + target * 0.35;
  if (input.consecutiveFailures > 0) next -= Math.min(20, input.consecutiveFailures * 5);
  return Math.round(Math.max(0, Math.min(100, next)) * 10) / 10;
}

export function tierFor(reputation: number): 'high' | 'normal' | 'low' {
  if (reputation >= 80) return 'high';
  if (reputation >= 50) return 'normal';
  return 'low';
}

export function reputationLabel(reputation: number): string {
  if (reputation >= 80) return '优质';
  if (reputation >= 60) return '良好';
  if (reputation >= 40) return '一般';
  if (reputation > 0) return '较差';
  return '失联';
}

/** Expected probe interval in hours, derived from tier. */
export function probeIntervalHours(tier: SourceConfig['tier']): number {
  return tier === 'high' ? 12 : tier === 'normal' ? 72 : 168;
}
