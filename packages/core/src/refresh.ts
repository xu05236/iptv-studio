export interface RefreshInput {
  refreshHours?: number | null;
  weight?: number | null;
  createdAt?: string | null;
  now?: number;
}

/**
 * 每个源的抓取间隔：自定义值优先（24 小时是历史默认值，视为“跟随分档”）；
 * 否则收藏源 12 小时、7 天内新增源 24 小时、普通源 72 小时。
 *
 * 0 表示“不自动刷新”，仅供手动抓取。
 */
export function effectiveRefreshHours(input: RefreshInput): number {
  const raw = input.refreshHours;
  if (raw === 0) return 0;
  if (typeof raw === 'number' && raw > 0 && raw !== 24) return raw;
  if (Number(input.weight ?? 1) >= 2) return 12;
  const created = input.createdAt ? Date.parse(input.createdAt) : NaN;
  const now = input.now ?? Date.now();
  if (Number.isFinite(created) && now - created < 7 * 86_400_000) return 24;
  return 72;
}
