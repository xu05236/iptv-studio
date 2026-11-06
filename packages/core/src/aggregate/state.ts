import type { AppSettings, LineEntry } from '../types.js';

export interface StatusTransition {
  status: LineEntry['status'];
  failCount: number;
  passCount?: number;
  /** 进入已淘汰终态的时间（保留 30 天后清理）。 */
  rejectedAt?: string;
  /** probe was inconclusive (e.g. RTSP from an HTTP runtime) */
  skipped?: boolean;
}

export function isInconclusive(result: { ok: boolean; error?: string }): boolean {
  return !result.ok && /无法在 HTTP 环境中探测/.test(result.error ?? '');
}

/**
 * 线路生命周期（2026-11 起）：
 *   新线路（从未可用）：待测 --失败--> 待复测 --失败--> 已淘汰（终态）
 *   老线路（曾经可用）：可用 --失败--> 待复测 --失败--> 待复测 --失败--> 已淘汰（终态）
 *   待复测成功 --> 可用
 *   已淘汰不再自动探测，只能手动复活。
 *
 * `everAlive` 缺省时用 `passCount > 0` 推断，兼容升级前的旧数据。
 */
export function transition(
  previous: Pick<LineEntry, 'status' | 'failCount' | 'passCount' | 'everAlive'>,
  result: { ok: boolean; error?: string },
  options: { now?: Date } = {},
): StatusTransition {
  if (isInconclusive(result)) {
    return {
      status: previous.status,
      failCount: previous.failCount,
      passCount: previous.passCount,
      skipped: true,
    };
  }

  if (result.ok) {
    return { status: 'alive', failCount: 0, passCount: (previous.passCount ?? 0) + 1 };
  }

  const now = options.now ?? new Date();
  const failCount = Math.min(99, previous.failCount + 1);
  const everAlive = previous.everAlive ?? (previous.passCount ?? 0) > 0;
  // 新线路只给一次复测：第二次失败直接淘汰；老线路保持 3 次。
  if (failCount >= (everAlive ? 3 : 2)) {
    return { status: 'dead', failCount, passCount: 0, rejectedAt: now.toISOString() };
  }
  return { status: 'suspect', failCount, passCount: 0 };
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
  line: Pick<LineEntry, 'status' | 'lastProbeAt'>,
  tier: ProbeTier,
  now: Date = new Date(),
): boolean {
  // 已淘汰是终态：只有手动复活会把它改回待测。
  if (line.status === 'dead') return false;
  if (!line.lastProbeAt) return true;
  // A failed/suspect line should be retried much sooner than a healthy one;
  // otherwise a new source's first bad probe would sit idle for 72h.
  const ttl = line.status === 'suspect' ? 12 * 3_600_000 : TIER_TTL_HOURS[tier] * 3_600_000;
  return new Date(line.lastProbeAt).getTime() + ttl <= now.getTime();
}

/** 已淘汰且超过保留天数，可以清理（默认 30 天）。 */
export function isPurgeable(
  line: Pick<LineEntry, 'status' | 'rejectedAt'>,
  retentionDays = 30,
  now: Date = new Date(),
): boolean {
  if (line.status !== 'dead' || !line.rejectedAt) return false;
  const days = Math.max(1, Number(retentionDays) || 30);
  return new Date(line.rejectedAt).getTime() + days * 86_400_000 <= now.getTime();
}

export function sourceHealth(alive: number, total: number): 'healthy' | 'degraded' | 'failing' {
  if (total <= 0) return 'failing';
  const ratio = alive / total;
  if (ratio >= 0.4) return 'healthy';
  if (ratio > 0) return 'degraded';
  return 'failing';
}
