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
 * `total` must be the number of **tested** lines (alive+dead+suspect), not all
 * imported lines: otherwise a source with many pending lines looks broken.
 */
export function nextReputation(input: ReputationInput): number {
  const tested = Math.max(0, input.total);
  const availability = tested > 0 ? input.alive / tested : 0.5;
  const quality = Math.max(0, Math.min(1, input.avgScore / 100));
  let target = 100 * (0.75 * availability + 0.25 * quality);
  if (!tested) target = 50;
  if (!input.fetchOk) target *= 0.45;

  const previous = Number.isFinite(input.previous) ? input.previous : 50;
  let next = previous * 0.45 + target * 0.55;
  // Recover from a historically low score once there is enough evidence.
  if (tested >= 20 && target > 40) next = Math.max(next, target * 0.8);
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
