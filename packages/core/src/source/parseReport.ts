/** Diagnostic report persisted after every non-skipped source fetch. */
export interface SourceParseReport {
  detectedKind: string;
  entries: number;
  bytes: number;
  /** F4: body encoding used to decode the source (utf-8 / gbk / …). */
  encoding?: string | null;
  warnings: string[];
  /** 0 = primary URL, 1+ = which mirror answered. */
  mirrorIndex: number;
  fetchedAt: string;
  /** Filled by the Worker when the entry count dropped versus the previous run. */
  dropPercent?: number | null;
}

/** A drop below this percent is normal churn and stays hidden. */
export const PARSE_DROP_THRESHOLD = 30;
/** Ignore tiny baselines so a 3-entry source doesn't flash warnings. */
export const PARSE_DROP_MIN_BASELINE = 20;

/** Percent drop versus the previous entry count, or null when not meaningful. */
export function computeParseDrop(previous: number | null | undefined, current: number): number | null {
  const before = Number(previous ?? 0);
  if (!Number.isFinite(before) || before < PARSE_DROP_MIN_BASELINE || current <= 0) return null;
  const drop = Math.round(((before - current) / before) * 1000) / 10;
  return drop > 0 ? drop : null;
}
