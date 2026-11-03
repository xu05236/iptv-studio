import type { AppSettings } from '@iptv/core';
import type { Env } from '../env.js';
import { audit, loadSettings } from '../db.js';
import { workflowRunStatus } from './github.js';
import { getJson } from './store.js';
import { createTask, dispatchNext, loadTasks } from './tasks.js';

/** Beijing is UTC+8 with no DST; the scheduler stores local HH:mm and matches in UTC. */
const BEIJING_OFFSET_MS = 8 * 3_600_000;
const RUN_WINDOW_MS = 15 * 60_000;
const AUTO_PUBLISH_INTERVAL_MS = 2 * 3_600_000;

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

export function nextAutoLivenessAt(settings: AppSettings, nowMs = Date.now()): number | null {
  if (!settings.autoLivenessEnabled) return null;
  return nextScheduledAt(parseCollectTimes(settings.autoLivenessTimes), nowMs);
}

export function nextAutoPublishAt(settings: AppSettings, nowMs = Date.now()): number | null {
  if (!settings.autoPublishEnabled) return null;
  return nextScheduledAt(parseCollectTimes(settings.autoPublishTimes), nowMs);
}

interface ScheduleState {
  lastRunAt?: string;
  lastScheduledAt?: string;
  result?: string;
}

interface SchedulerConfig {
  command: 'collect' | 'liveness' | 'publish';
  enabled: boolean;
  times: string;
  stateKey: string;
}

function schedulerConfigs(settings: AppSettings): SchedulerConfig[] {
  return [
    {
      command: 'collect',
      enabled: Boolean(settings.autoCollectEnabled),
      times: settings.autoCollectTimes,
      stateKey: 'state/schedule.json',
    },
    {
      command: 'publish',
      enabled: Boolean(settings.autoPublishEnabled),
      times: settings.autoPublishTimes,
      stateKey: 'state/publish-schedule.json',
    },
    {
      command: 'liveness',
      enabled: Boolean(settings.autoLivenessEnabled),
      times: settings.autoLivenessTimes,
      stateKey: 'state/liveness-schedule.json',
    },
  ];
}

interface DueSlot {
  config: SchedulerConfig;
  scheduledAt: number;
}

/**
 * Runs on the 5-minute Worker cron. Each enabled schedule (collect / liveness)
 * has its own Beijing-local times and state file. A slot only fires when it
 * just passed, it was not attempted before, KV writes are below the hard guard
 * and no workflow run is active. When both are due, collect wins and liveness
 * waits for the next tick (the GitHub concurrency group would queue anyway).
 */
export async function runScheduler(env: Env): Promise<void> {
  const settings = await loadSettings(env);
  const now = Date.now();
  const due: DueSlot[] = [];

  for (const config of schedulerConfigs(settings)) {
    if (!config.enabled) continue;
    const times = parseCollectTimes(config.times);
    if (!times.length) continue;
    const scheduledAt = mostRecentScheduledAt(times, now);
    if (scheduledAt === null || now - scheduledAt > RUN_WINDOW_MS) continue;
    const state = await getJson<ScheduleState>(env, config.stateKey);
    const lastAttempt = state?.lastRunAt ? Date.parse(state.lastRunAt) : 0;
    if (lastAttempt >= scheduledAt) continue;
    due.push({ config, scheduledAt });
  }
  if (!due.length) {
    const at = Date.now();
    let enqueued = false;
    if (await runFetchWatch(env, settings, at)) enqueued = true;
    if (await runProbeWatch(env, settings, at)) enqueued = true;
    await runAutoPublishAfterProbe(env, settings, at);
    await dispatchNext(env);
    return;
  }

  const record = async (config: SchedulerConfig, scheduledAt: number, result: string): Promise<void> => {
    const next: ScheduleState = {
      lastRunAt: new Date(now).toISOString(),
      lastScheduledAt: new Date(scheduledAt).toISOString(),
      result,
    };
    await env.KV.put(config.stateKey, JSON.stringify(next));
  };

  const today = new Date(now).toISOString().slice(0, 10);
  const usage = await getJson<{ kv?: { day?: string; writes?: number } }>(env, 'state/usage.json');
  const writes = usage?.kv?.day === today ? Number(usage.kv.writes ?? 0) : 0;

  let running = false;
  if (writes < 920) {
    const runs = (await workflowRunStatus(env)) as Array<{ status?: string }> | null;
    running = Array.isArray(runs) && runs.some((run) => run.status === 'queued' || run.status === 'in_progress');
  }

  let enqueued = false;
  for (const { config, scheduledAt } of due) {
    if (writes >= 920) {
      await record(config, scheduledAt, 'skipped: KV quota');
      continue;
    }
    if (running) {
      await record(config, scheduledAt, 'skipped: workflow running');
      continue;
    }
    const budget = Math.max(1, Number(settings.probeBudget) || 1200);
    const task = await createTask(env, {
      type: config.command,
      source: 'schedule',
      priority: 50,
      payload: { budget: String(budget) },
    });
    await record(config, scheduledAt, 'queued');
    await audit(env, 'scheduler', `schedule.${config.command}`, task.id);
    enqueued = true;
  }

  const at = Date.now();
  if (await runFetchWatch(env, settings, at)) enqueued = true;
  if (await runProbeWatch(env, settings, at)) enqueued = true;
  await runAutoPublishAfterProbe(env, settings, at);
  // Always drain the queue, even when no scheduled task was newly enqueued.
  // Otherwise manual/source tasks can sit queued until the next schedule event.
  await dispatchNext(env);
}

/**
 * Probe only updates the line pool. If the pool is newer than the published
 * catalog, publish automatically, but at most once every two hours so hourly
 * probes cannot exhaust the KV write budget.
 */
async function runAutoPublishAfterProbe(env: Env, settings: AppSettings, now: number): Promise<boolean> {
  if (!settings.autoPublishEnabled) return false;
  const [index, pool, last, tasks] = await Promise.all([
    getJson<{ generatedAt?: string }>(env, 'state/index.json'),
    getJson<{ generatedAt?: string }>(env, 'state/pool-stats.json'),
    getJson<{ at?: string }>(env, 'state/auto-publish-after-probe.json'),
    loadTasks(env),
  ]);
  if (!index?.generatedAt || !pool?.generatedAt) return false;
  if (Date.parse(pool.generatedAt) <= Date.parse(index.generatedAt)) return false;
  if (now - Date.parse(last?.at ?? '') < AUTO_PUBLISH_INTERVAL_MS) return false;
  if (tasks.some((task) => task.type === 'publish' && (task.status === 'queued' || task.status === 'running'))) return false;
  const task = await createTask(env, { type: 'publish', source: 'schedule', priority: 40, payload: { auto: 'after-probe' } });
  await env.KV.put('state/auto-publish-after-probe.json', JSON.stringify({ at: new Date(now).toISOString(), taskId: task.id }));
  await audit(env, 'scheduler', 'schedule.auto-publish-after-probe', task.id);
  return true;
}

interface IntervalState {
  lastRunAt?: string;
  nextRunAt?: string;
  result?: string;
}

async function intervalGuard(env: Env): Promise<'quota' | 'running' | null> {
  const today = new Date().toISOString().slice(0, 10);
  const usage = await getJson<{ kv?: { day?: string; writes?: number } }>(env, 'state/usage.json');
  const writes = usage?.kv?.day === today ? Number(usage.kv.writes ?? 0) : 0;
  if (writes >= 920) return 'quota';
  const runs = (await workflowRunStatus(env)) as Array<{ status?: string }> | null;
  if (Array.isArray(runs) && runs.some((run) => run.status === 'queued' || run.status === 'in_progress')) return 'running';
  return null;
}

async function recordInterval(env: Env, key: string, now: number, nextMs: number, result: string): Promise<void> {
  const state: IntervalState = {
    lastRunAt: new Date(now).toISOString(),
    nextRunAt: new Date(nextMs).toISOString(),
    result,
  };
  await env.KV.put(key, JSON.stringify(state));
}

const PHASES = ['pending', 'quarantine', 'rejected'] as const;

function phaseList(value: string): string[] {
  return String(value ?? '').split(/[\s,，]+/).map((item) => item.trim()).filter((item) => (PHASES as readonly string[]).includes(item));
}

/** Weekly-ish fetch task, independent from daily publish/probe. */
async function runFetchWatch(env: Env, settings: AppSettings, now: number): Promise<boolean> {
  if (!settings.autoFetchEnabled) return false;
  const state = await getJson<IntervalState>(env, 'state/fetch-schedule.json');
  if (state?.nextRunAt && Date.parse(state.nextRunAt) > now) return false;
  const intervalMs = Math.max(1, Number(settings.fetchIntervalDays) || 7) * 86_400_000;
  const guard = await intervalGuard(env);
  if (guard) {
    await recordInterval(env, 'state/fetch-schedule.json', now, now + 30 * 60_000, `skipped: ${guard}`);
    return false;
  }
  const task = await createTask(env, { type: 'fetch', source: 'schedule', priority: 50, payload: {} });
  await recordInterval(env, 'state/fetch-schedule.json', now, now + intervalMs, 'queued');
  await audit(env, 'scheduler', 'schedule.fetch', task.id);
  return true;
}

/** Batched probe scheduler: enqueue only while unpaused phases still have work. */
async function runProbeWatch(env: Env, settings: AppSettings, now: number): Promise<boolean> {
  if (!settings.autoProbeEnabled) return false;
  const state = await getJson<IntervalState>(env, 'state/probe-schedule.json');
  if (state?.nextRunAt && Date.parse(state.nextRunAt) > now) return false;
  const intervalMs = Math.max(1, Number(settings.autoProbeIntervalHours) || 2) * 3_600_000;
  const stats = await getJson<Record<string, number>>(env, 'state/pool-stats.json');
  const paused = new Set(phaseList(settings.probePausedPhases));
  const hasWork = !stats || PHASES.some((phase) => !paused.has(phase) && Number(stats[phase] ?? 0) > 0);
  if (!hasWork) {
    await recordInterval(env, 'state/probe-schedule.json', now, now + intervalMs, 'idle: no due lines');
    return false;
  }

  const guard = await intervalGuard(env);
  if (guard) {
    await recordInterval(env, 'state/probe-schedule.json', now, now + 15 * 60_000, `skipped: ${guard}`);
    return false;
  }
  const task = await createTask(env, {
    type: 'probe-batch',
    source: 'schedule',
    priority: 50,
    payload: {},
    total: Math.max(0, Number(settings.probeBatchSize) || 1200),
    unit: 'lines',
  });
  await recordInterval(env, 'state/probe-schedule.json', now, now + intervalMs, 'queued');
  await audit(env, 'scheduler', 'schedule.probe-batch', task.id);
  return true;
}
