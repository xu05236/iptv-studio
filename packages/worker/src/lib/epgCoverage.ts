export interface GuideLike {
  generatedAt?: string;
  hours?: number;
  channels?: Record<string, Array<{ end?: string }>>;
}

export interface CoverageSummary {
  total: number;
  covered: number;
  coveredAny: number;
  stale: number;
  percent: number;
  guideAgeHours: number | null;
  guideStale: boolean;
  missingIds: string[];
  staleIds: string[];
}

const STALE_AFTER_HOURS = 26;

/**
 * Coverage must not count channels whose last programme already ended: an EPG
 * snapshot that stops updating otherwise reports 100% while players show
 * "no programme information".
 */
export function summarizeCoverage(channelIds: string[], guide: GuideLike | null, now = Date.now()): CoverageSummary {
  const coveredAny = new Set<string>();
  const expired = new Set<string>();
  for (const [channelId, programmes] of Object.entries(guide?.channels ?? {})) {
    if (!Array.isArray(programmes) || programmes.length === 0) continue;
    coveredAny.add(channelId);
    const hasUpcoming = programmes.some((programme) => {
      const end = programme?.end ? Date.parse(programme.end) : Number.NaN;
      return !Number.isFinite(end) || end >= now;
    });
    if (!hasUpcoming) expired.add(channelId);
  }
  const known = new Set(channelIds);
  const missingIds = channelIds.filter((id) => !coveredAny.has(id));
  const staleIds = channelIds.filter((id) => expired.has(id));
  const total = channelIds.length;
  const covered = Math.max(0, total - missingIds.length - staleIds.length);
  const guideAt = guide?.generatedAt ? Date.parse(guide.generatedAt) : Number.NaN;
  const guideAgeHours = Number.isFinite(guideAt) ? Math.max(0, Math.round((now - guideAt) / 3_600_000)) : null;
  return {
    total,
    covered,
    coveredAny: [...coveredAny].filter((id) => known.has(id)).length,
    stale: staleIds.length,
    percent: total ? Math.round((covered / total) * 100) : 0,
    guideAgeHours,
    guideStale: guideAgeHours === null || guideAgeHours > STALE_AFTER_HOURS,
    missingIds,
    staleIds,
  };
}
