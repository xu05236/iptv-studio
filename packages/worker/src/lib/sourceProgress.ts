import type { Env } from '../env.js';

export interface SourceCounts {
  total: number;
  alive: number;
  pending: number;
  quarantine: number;
  rejected: number;
}

export interface SourceProgressRow extends SourceCounts {
  source_id: string;
  report_at: string;
  delta: string;
  version: number;
}

export const ZERO_COUNTS: SourceCounts = { total: 0, alive: 0, pending: 0, quarantine: 0, rejected: 0 };

/** Bumped whenever the count definition changes, so stale baselines are ignored. */
export const PROGRESS_VERSION = 2;

/** Difference between two probeable snapshots; null when there is no baseline yet. */
export function deltaOf(current: SourceCounts, previous: SourceCounts | null): SourceCounts | null {
  if (!previous) return null;
  return {
    total: current.total - previous.total,
    alive: current.alive - previous.alive,
    pending: current.pending - previous.pending,
    quarantine: current.quarantine - previous.quarantine,
    rejected: current.rejected - previous.rejected,
  };
}

export function parseDelta(raw: string | undefined): SourceCounts | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SourceCounts>;
    if (typeof parsed.total !== 'number') return null;
    return {
      total: parsed.total ?? 0,
      alive: parsed.alive ?? 0,
      pending: parsed.pending ?? 0,
      quarantine: parsed.quarantine ?? 0,
      rejected: parsed.rejected ?? 0,
    };
  } catch {
    return null;
  }
}

export async function listSourceProgress(env: Env): Promise<Map<string, SourceProgressRow>> {
  const map = new Map<string, SourceProgressRow>();
  try {
    const { results } = await env.DB.prepare(
      'SELECT source_id, report_at, total, alive, pending, quarantine, rejected, delta, version FROM source_progress',
    ).all<SourceProgressRow>();
    for (const row of results) map.set(row.source_id, row);
  } catch {
    // The table appears with migration 0032; treat a missing table as "no baseline".
  }
  return map;
}

export async function saveSourceProgress(
  env: Env,
  sourceId: string,
  reportAt: string,
  counts: SourceCounts,
  delta: SourceCounts | null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO source_progress (source_id, report_at, total, alive, pending, quarantine, rejected, delta, version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(source_id) DO UPDATE SET
       report_at = excluded.report_at, total = excluded.total, alive = excluded.alive,
       pending = excluded.pending, quarantine = excluded.quarantine, rejected = excluded.rejected,
       delta = excluded.delta, version = excluded.version, updated_at = datetime('now')`,
  ).bind(
    sourceId,
    reportAt,
    counts.total,
    counts.alive,
    counts.pending,
    counts.quarantine,
    counts.rejected,
    JSON.stringify(delta ?? {}),
    PROGRESS_VERSION,
  ).run();
}
