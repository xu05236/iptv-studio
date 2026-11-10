import type { Env } from '../env.js';
import { getJson } from './store.js';
import { getRuntimeJson, putRuntimeJson } from './runtime-state.js';
import { sendTelegram } from './telegram.js';

/** The pool snapshot drives every subscription; if it stops refreshing nobody notices. */
const STALE_MS = 26 * 3_600_000;
/** Do not repeat the same alert more often than this. */
const ALERT_GAP_MS = 6 * 3_600_000;

interface PoolStats {
  generatedAt?: string;
  total?: number;
  alive?: number;
  pending?: number;
  quarantine?: number;
}

interface Metrics {
  alive?: number;
  total?: number;
  at?: string;
}

/**
 * Cheap monitoring pass, called from the 5-minute scheduler:
 * - alert when the published pool snapshot is older than 26 hours;
 * - alert when the available line count (or the whole line count) halves
 *   between two passes, which catches an accidental wipe before the daily
 *   report does.
 */
export async function runMonitor(env: Env): Promise<void> {
  try {
    const stats = await getJson<PoolStats>(env, 'state/pool-stats.json');
    if (!stats?.generatedAt) return;
    const now = Date.now();
    const generatedAt = Date.parse(stats.generatedAt);
    if (Number.isFinite(generatedAt) && now - generatedAt > STALE_MS) {
      const hours = Math.round((now - generatedAt) / 3_600_000);
      await alertOnce(
        env,
        'pool-stale',
        `⏰ 池快照已 ${hours} 小时未更新（上次 ${stats.generatedAt}）。订阅导出可能还在用旧数据，请检查抓源/发布任务。`,
      );
    }

    const alive = Number(stats.alive ?? 0);
    const total = Number(stats.total ?? 0);
    const previous = await getRuntimeJson<Metrics>(env, 'state/metrics.json');
    if (previous) {
      const prevAlive = Number(previous.alive ?? 0);
      const prevTotal = Number(previous.total ?? 0);
      if (prevAlive >= 100 && alive < prevAlive * 0.5) {
        await alertOnce(
          env,
          'alive-drop',
          `⚠️ 可用线路骤降：${prevAlive} → ${alive}（${Math.round((alive / prevAlive) * 100)}%）。请检查最近的抓源/探测/发布。`,
        );
      } else if (prevTotal >= 1000 && total < prevTotal * 0.5) {
        await alertOnce(
          env,
          'line-drop',
          `⚠️ 线路总数骤降：${prevTotal} → ${total}（${Math.round((total / prevTotal) * 100)}%）。请检查线路分片与恢复操作。`,
        );
      }
    }

    if (!previous || previous.alive !== alive || previous.total !== total) {
      await putRuntimeJson(env, 'state/metrics.json', { alive, total, at: new Date().toISOString() });
    }
  } catch (error) {
    console.warn('monitor failed', error instanceof Error ? error.message : String(error));
  }
}

async function alertOnce(env: Env, key: string, text: string): Promise<void> {
  const now = Date.now();
  const alerts = (await getRuntimeJson<Record<string, string>>(env, 'state/alerts.json')) ?? {};
  const last = alerts[key] ? Date.parse(alerts[key]) : 0;
  if (last && now - last < ALERT_GAP_MS) return;
  alerts[key] = new Date(now).toISOString();
  await putRuntimeJson(env, 'state/alerts.json', alerts);
  await sendTelegram(env, text);
}
