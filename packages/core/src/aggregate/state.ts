import type { AppSettings, LineEntry } from '../types.js';

export interface StatusTransition {
  status: LineEntry['status'];
  failCount: number;
  reviveAt?: string;
  /** probe was inconclusive (e.g. RTSP from an HTTP runtime) */
  skipped?: boolean;
}

export function isInconclusive(result: { ok: boolean; error?: string }): boolean {
  return !result.ok && /无法在 HTTP 环境中探测/.test(result.error ?? '');
}

/**
 * Line lifecycle:
 *   alive --fail--> suspect(1) --fail--> suspect(2) --fail--> dead
 *   dead --success--> alive
 *   dead --14 days--> eligible for one more probe
 *
 * One failure already removes the line from subscriptions (see `shouldExport`),
 * but it takes three consecutive failures before it stops being probed — that is
 * what keeps flapping lines from being lost forever.
 */
export function transition(
  previous: Pick<LineEntry, 'status' | 'failCount' | 'reviveAt'>,
  result: { ok: boolean; error?: string },
  options: { reviveDays?: number; now?: Date } = {},
): StatusTransition {
  if (isInconclusive(result)) {
    return { status: previous.status, failCount: previous.failCount, reviveAt: previous.reviveAt, skipped: true };
  }

  const now = options.now ?? new Date();
  if (result.ok) return { status: 'alive', failCount: 0 };

  const failCount = Math.min(99, previous.failCount + 1);
  if (failCount >= 3) {
    const days = options.reviveDays ?? 14;
    return {
      status: 'dead',
      failCount,
      reviveAt: new Date(now.getTime() + days * 86_400_000).toISOString(),
    };
  }
  return { status: 'suspect', failCount };
}

/**
 * Whether a line may appear in a playlist.
 * One failed probe is enough to drop it; if the whole channel would be empty the
 * best "suspect" lines are used as compensation so subscribers never see blanks.
 */
export function shouldExport(
  line: Pick<LineEntry, 'status' | 'failCount'>,
  aliveInChannel: number,
  settings: Pick<AppSettings, 'compensate' | 'keepSuspect'>,
): boolean {
  if (line.status === 'alive') return true;
  if (line.failCount >= 5) return false;
  if (line.status === 'suspect' && !settings.keepSuspect) return false;
  if (!settings.compensate) return false;
  return aliveInChannel === 0;
}

export type ProbeTier = 'high' | 'normal' | 'low';

const TIER_TTL_HOURS: Record<ProbeTier, number> = { high: 12, normal: 72, low: 168 };

export function isDueForProbe(
  line: Pick<LineEntry, 'status' | 'lastProbeAt' | 'reviveAt'>,
  tier: ProbeTier,
  now: Date = new Date(),
): boolean {
  if (!line.lastProbeAt) return true;
  if (line.status === 'dead') {
    if (!line.reviveAt) return true;
    return new Date(line.reviveAt).getTime() <= now.getTime();
  }
  const ttl = TIER_TTL_HOURS[tier] * 3_600_000;
  return new Date(line.lastProbeAt).getTime() + ttl <= now.getTime();
}

/** Dead long enough to forget about (quarterly cleanup). */
export function isPurgeable(line: Pick<LineEntry, 'status' | 'reviveAt'>, now: Date = new Date()): boolean {
  if (line.status !== 'dead' || !line.reviveAt) return false;
  return new Date(line.reviveAt).getTime() + 90 * 86_400_000 <= now.getTime();
}

export function sourceHealth(alive: number, total: number): 'healthy' | 'degraded' | 'failing' {
  if (total <= 0) return 'failing';
  const ratio = alive / total;
  if (ratio >= 0.4) return 'healthy';
  if (ratio > 0) return 'degraded';
  return 'failing';
}
