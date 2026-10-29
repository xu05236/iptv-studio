import type { Env } from './env.js';
import { loadSettings, purgeOldRows } from './db.js';

const DAY = 86_400_000;

/**
 * Six-hourly housekeeping. Heavy collection/probing deliberately runs in
 * GitHub Actions; cron only does cheap bookkeeping (KV artifacts + D1 rows).
 */
export async function runCron(env: Env): Promise<void> {
  await purgeOldRows(env, 90);
  await env.DB.prepare(
    "UPDATE sources SET status = 'degraded' WHERE enabled = 1 AND status <> 'degraded' AND last_ok_at IS NOT NULL AND last_ok_at < datetime('now', '-7 days') AND (last_fetch_at IS NULL OR last_fetch_at < datetime('now', '-7 days'))",
  ).run();

  const settings = await loadSettings(env);
  await prunePrefix(env, 'snapshots/', Math.max(3, Math.min(30, settings.retentionDays)));
  await prunePrefix(env, 'logs/', 30);
  await prunePrefix(env, 'shots/', 30);
}

/** Delete KV artifacts older than N days (metadata.updatedAt is set on write). */
async function prunePrefix(env: Env, prefix: string, days: number): Promise<number> {
  const cutoff = Date.now() - days * DAY;
  let cursor: string | undefined;
  let deleted = 0;

  for (let page = 0; page < 5; page++) {
    const listing = await env.KV.list({ prefix, cursor, limit: 1000 });
    const stale = listing.keys.filter((key) => {
      const updatedAt = (key.metadata as { updatedAt?: string } | null)?.updatedAt;
      if (!updatedAt) return false;
      return new Date(updatedAt).getTime() < cutoff;
    });
    if (stale.length) {
      await Promise.all(stale.map((key) => env.KV.delete(key.name)));
      deleted += stale.length;
    }
    if (listing.list_complete) break;
    cursor = listing.cursor;
  }
  return deleted;
}
