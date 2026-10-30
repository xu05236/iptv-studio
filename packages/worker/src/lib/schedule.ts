import type { AppSettings } from '@iptv/core';
import type { Env } from '../env.js';
import { audit, loadSettings } from '../db.js';
import { dispatchWorkflow, workflowRunStatus } from './github.js';
import { getJson } from './store.js';

/** Beijing is UTC+8 with no DST; the scheduler stores local HH:mm and matches in UTC. */
const BEIJING_OFFSET_MS = 8 * 3_600_000;
const RUN_WINDOW_MS = 15 * 60_000;

export interface CollectTime {
  hour: number;
  minute: number;
}

/** Parse "08:30, 20:30" into sorted, de-duplicated Beijing-local times. */
export function parseCollectTimes(value: string | null | undefined): CollectTime[] {
  const unique = new Map<string, CollectTime>();
  for (const token of String(value ?? '').split(/[\s,，]+/)) {
    const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(token.trim());
    if (!match) continue;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    unique.set(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, { hour, minute });
  }
  return [...unique.values()].sort((a, b) => a.hour - b.hour || a.minute - b.minute);
}

function beijingDay(nowMs: number): { year: number; month: number; day: number } {
  const date = new Date(nowMs + BEIJING_OFFSET_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate() };
}

/** UTC instants for the given Beijing-local times on the Beijing day containing `dayMs`. */
function instantsForDay(times: CollectTime[], dayMs: number): number[] {
  const { year, month, day } = beijingDay(dayMs);
  return times.map((time) => Date.UTC(year, month, day, time.hour - 8, time.minute));
}

/** Latest scheduled instant at or before now (checks today and yesterday in Beijing). */
export function mostRecentScheduledAt(times: CollectTime[], nowMs: number): number | null {
  const candidates = [...instantsForDay(times, nowMs), ...instantsForDay(times, nowMs - 86_400_000)].filter((at) => at <= nowMs);
  return candidates.length ? Math.max(...candidates) : null;
}

/** Next scheduled instant at or after now (checks today and tomorrow in Beijing). */
export function nextScheduledAt(times: CollectTime[], nowMs: number): number | null {
  const candidates = [...instantsForDay(times, nowMs), ...instantsForDay(times, nowMs + 86_400_000)].filter((at) => at >= nowMs);
  return candidates.length ? Math.min(...candidates) : null;
}

export function nextAutoCollectAt(settings: AppSettings, nowMs = Date.now()): number | null {
  if (!settings.autoCollectEnabled) return null;
  return nextScheduledAt(parseCollectTimes(settings.autoCollectTimes), nowMs);
}

interface ScheduleState {
  lastRunAt?: string;
  lastScheduledAt?: string;
  result?: string;
}

/**
 * Runs on a 5-minute Worker cron. Dispatches collect only when a configured
 * Beijing-local time just passed, the previous attempt was older than that
 * slot, KV writes are below the hard guard, and no collect is already running.
 * Every exit path records the attempt so a bad slot cannot retry every 5 min.
 */
export async function runAutoCollect(env: Env): Promise<void> {
  const settings = await loadSettings(env);
  if (!settings.autoCollectEnabled) return;
  const times = parseCollectTimes(settings.autoCollectTimes);
  if (!times.length) return;

  const now = Date.now();
  const scheduledAt = mostRecentScheduledAt(times, now);
  if (scheduledAt === null || now - scheduledAt > RUN_WINDOW_MS) return;

  const state = await getJson<ScheduleState>(env, 'state/schedule.json');
  const lastAttempt = state?.lastRunAt ? Date.parse(state.lastRunAt) : 0;
  if (lastAttempt >= scheduledAt) return;

  const record = async (result: string): Promise<void> => {
    const next: ScheduleState = {
      lastRunAt: new Date(now).toISOString(),
      lastScheduledAt: new Date(scheduledAt).toISOString(),
      result,
    };
    await env.KV.put('state/schedule.json', JSON.stringify(next));
  };

  const today = new Date(now).toISOString().slice(0, 10);
  const usage = await getJson<{ kv?: { day?: string; writes?: number } }>(env, 'state/usage.json');
  const writes = usage?.kv?.day === today ? Number(usage.kv.writes ?? 0) : 0;
  if (writes >= 920) {
    await record('skipped: KV quota');
    return;
  }

  const runs = (await workflowRunStatus(env)) as Array<{ status?: string }> | null;
  if (Array.isArray(runs) && runs.some((run) => run.status === 'queued' || run.status === 'in_progress')) {
    await record('skipped: collect running');
    return;
  }

  const budget = Math.max(1, Number(settings.probeBudget) || 1200);
  const result = await dispatchWorkflow(env, { command: 'collect', force: 'false', budget: String(budget) });
  await record(result.ok ? 'dispatched' : `failed: ${result.message}`);
  await audit(env, 'scheduler', 'schedule.collect', 'github', {
    scheduledAt: new Date(scheduledAt).toISOString(),
    budget,
    ...result,
  });
}
