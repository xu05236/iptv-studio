import type { Env } from '../env.js';

export interface RelayUsageRow {
  token: string;
  day: string;
  requests: number;
  bytes: number;
}

const buffer = new Map<string, RelayUsageRow>();
let lastFlush = 0;
let lastRecordAt = 0;
const FLUSH_INTERVAL_MS = 5 * 60_000;
const IDLE_GAP_MS = 2 * 60_000;
const MAX_BUFFER = 100;

export function relayUsageKey(token: string, day: string): string {
  return `${day}|${token}`;
}

/**
 * In-memory counters flushed to D1 in batches. Per-request D1 writes would burn
 * the daily row budget, so at most one UPSERT per token per 5 minutes.
 */
export function recordRelayUsage(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void } | undefined,
  token: string,
  bytes: number,
): void {
  if (!env.DB || !token) return;
  const now = Date.now();
  // After a quiet period, flush the previous session's counters before they can
  // be lost to an isolate shutdown.
  const idleFlush = lastRecordAt > 0 && now - lastRecordAt > IDLE_GAP_MS && buffer.size > 0;
  lastRecordAt = now;
  const day = new Date().toISOString().slice(0, 10);
  const key = relayUsageKey(token, day);
  const row = buffer.get(key) ?? { token, day, requests: 0, bytes: 0 };
  row.requests += 1;
  row.bytes += Math.max(0, bytes);
  buffer.set(key, row);

  if (idleFlush || buffer.size >= MAX_BUFFER || (buffer.size > 0 && now - lastFlush >= FLUSH_INTERVAL_MS)) {
    const rows = [...buffer.values()];
    buffer.clear();
    lastFlush = now;
    const pending = flushRelayUsage(env, rows);
    if (ctx) ctx.waitUntil(pending);
    else void pending;
  }
}

export async function flushRelayUsage(env: Env, rows: RelayUsageRow[]): Promise<void> {
  if (!env.DB || !rows.length) return;
  await env.DB.batch(
    rows.map((row) =>
      env.DB.prepare(
        `INSERT INTO relay_usage (token, day, requests, bytes) VALUES (?, ?, ?, ?)
         ON CONFLICT(token, day) DO UPDATE SET requests = requests + excluded.requests, bytes = bytes + excluded.bytes`,
      ).bind(row.token, row.day, row.requests, row.bytes),
    ),
  );
}
