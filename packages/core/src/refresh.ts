export interface RefreshInput {
  refreshHours?: number | null;
  weight?: number | null;
  createdAt?: string | null;
  now?: number;
}

/**
 * 每个源的抓取间隔（小时）：
 * - null / undefined / -1：跟随分档（收藏源 12h、7 天内新增 24h、其它 72h）
 * - 0：不自动抓取，只手动
 * - 正数：自定义小时（24 = 每天、48 = 每 2 天、72 = 每 3 天…）
 */
export function effectiveRefreshHours(input: RefreshInput): number {
  const raw = input.refreshHours;
  if (raw !== null && raw !== undefined) {
    const hours = Number(raw);
    if (Number.isFinite(hours)) {
      if (hours < 0) return tierRefreshHours(input.weight, input.createdAt, input.now);
      return hours === 0 ? 0 : hours;
    }
  }
  return tierRefreshHours(input.weight, input.createdAt, input.now);
}

/** 分档：收藏（权重 ≥ 2）12h、7 天内新增 24h、其它 72h。 */
export function tierRefreshHours(weight?: number | null, createdAt?: string | null, now = Date.now()): number {
  if (Number(weight ?? 1) >= 2) return 12;
  const created = createdAt ? Date.parse(createdAt) : NaN;
  if (Number.isFinite(created) && now - created < 7 * 86_400_000) return 24;
  return 72;
}
