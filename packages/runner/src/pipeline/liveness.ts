import { canonicalPoolUrl, mapPool, probeLiveness, type AppSettings, type LineEntry } from '@iptv/core';
import type { RunLogger } from '../logger.js';

const PENDING_RETRY_HOURS = 6;

/**
 * Cheap pre-filter that runs inside collect before the expensive probes.
 * Never-tested lines and recently-failing suspects are checked with a manifest /
 * 2KB range first; failures are demoted and do not consume the full probe
 * budget, passers continue to the speed/resolution round.
 */
export async function prefilterLiveness(
  lines: LineEntry[],
  settings: AppSettings,
  concurrency: number,
  logger: RunLogger,
): Promise<Set<string>> {
  const blocked = new Set<string>();
  const budget = Math.max(0, Number(settings.probePrefilterBudget) || 0);
  if (!settings.probePrefilterEnabled || budget <= 0) return blocked;

  const now = Date.now();
  const retryMs = PENDING_RETRY_HOURS * 3_600_000;
  const seen = new Set<string>();
  const candidates = lines
    .filter((line) => {
      if (line.lastProbeAt) {
        if (line.status !== 'suspect') return false;
        if (line.lastLivenessAt && now - Date.parse(line.lastLivenessAt) < retryMs) return false;
      }
      const key = canonicalPoolUrl(line.url);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const pending = (line: LineEntry): number => (line.lastProbeAt ? 1 : 0);
      if (pending(a) !== pending(b)) return pending(a) - pending(b);
      const at = (line: LineEntry): number => Date.parse(line.lastLivenessAt ?? '') || 0;
      return at(a) - at(b);
    })
    .slice(0, budget);

  if (!candidates.length) return blocked;
  logger.info('轻量预筛计划', { candidates: candidates.length, budget });

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const workers = Math.max(1, Math.min(concurrency, 64));
  await mapPool(candidates, workers, async (line) => {
    const result = await probeLiveness(line.url, { headers: line.headers });
    if (result.inconclusive) {
      skipped++;
      return;
    }
    line.lastLivenessAt = new Date().toISOString();
    if (result.ok) {
      passed++;
      return;
    }
    failed++;
    blocked.add(line.key);
    line.failCount = Math.min(99, line.failCount + 1);
    line.error = result.error?.slice(0, 200);
    if (line.failCount >= 3) {
      line.status = 'dead';
      line.reviveAt = new Date(Date.now() + settings.deadReviveDays * 86_400_000).toISOString();
    } else {
      line.status = 'suspect';
    }
  });

  logger.info('轻量预筛完成', { checked: candidates.length, passed, failed, skipped, blocked: blocked.size });
  return blocked;
}
