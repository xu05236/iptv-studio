import type { AppSettings } from '@iptv/core';
import type { Env } from '../env.js';
import { audit, loadSettings } from '../db.js';
import { workflowRunStatus } from './github.js';
import { getJson } from './store.js';
import { getRuntimeJson, putRuntimeJson } from './runtime-state.js';
import { createSnapshot } from './snapshots.js';
import { createTask, dispatchNext, loadTasks, mutateTask, recordFinishedTask, type Task } from './tasks.js';

/** Beijing is UTC+8 with no DST; the scheduler stores local HH:mm and matches in UTC. */
const BEIJING_OFFSET_MS = 8 * 3_600_000;
const RUN_WINDOW_MS = 15 * 60_000;
const STUCK_TASK_MS = 90 * 60_000;

/** A running task with no progress for 90 minutes is considered dead. */
export function isStuckTask(task: Pick<Task, 'status' | 'startedAt' | 'lastHeartbeatAt' | 'createdAt'>, now = Date.now()): boolean {
  if (task.status !== 'running') return false;
  const last = Date.parse(task.lastHeartbeatAt ?? task.startedAt ?? task.createdAt);
  return Number.isFinite(last) && now - last > STUCK_TASK_MS;
}

async function recoverStuckTasks(env: Env, now: number): Promise<number> {
  const tasks = await loadTasks(env);
  const stuck = tasks.filter((task) => isStuckTask(task, now));
  for (const task of stuck) {
    await mutateTask(env, task.id, 'auto-fail');
  }
  if (stuck.length) await dispatchNext(env);
  return stuck.length;
}

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
  command: 'collect' | 'liveness' | 'publish' | 'epg' | 'snapshot';
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
      command: 'epg',
      enabled: Boolean(settings.epgRefreshEnabled),
      times: settings.epgRefreshTimes,
      stateKey: 'state/epg-schedule.json',
    },
    {
      command: 'snapshot',
      enabled: Boolean(settings.snapshotScheduleEnabled),
      times: settings.snapshotScheduleTimes,
      stateKey: 'state/snapshot-schedule.json',
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
  await recoverStuckTasks(env, now);
  const due: DueSlot[] = [];

  for (const config of schedulerConfigs(settings)) {
    if (!config.enabled) continue;
    const times = parseCollectTimes(config.times);
    if (!times.length) continue;
    const scheduledAt = mostRecentScheduledAt(times, now);
    if (scheduledAt === null || now - scheduledAt > RUN_WINDOW_MS) continue;
    const state = await getRuntimeJson<ScheduleState>(env, config.stateKey);
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
    await putRuntimeJson(env, config.stateKey, next);
  };

  const today = new Date(now).toISOString().slice(0, 10);
  const usage = await getRuntimeJson<{ kv?: { day?: string; writes?: number } }>(env, 'state/usage.json');
  const writes = usage?.kv?.day === today ? Number(usage.kv.writes ?? 0) : 0;
  const allowance = await loadActionsAllowance(env, settings);

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
    if (config.command === 'snapshot') {
      const item = await createSnapshot(env, 'scheduler');
      if (item) {
        await recordFinishedTask(env, {
          type: 'snapshot',
          source: 'schedule',
          message: `快照完成 · ${item.channels} 频道 · ${item.lines} 行 · ${item.alive} 可用`,
          payload: { origin: 'schedule' },
        });
      }
      await record(config, scheduledAt, item ? 'snapshot created' : 'skipped: no artifacts');
      continue;
    }
    if (running) {
      await record(config, scheduledAt, 'skipped: workflow running');
      continue;
    }
    if (allowance.blocked) {
      await record(config, scheduledAt, `skipped: Actions budget (${allowance.used}/${allowance.budget} min, ${allowance.autoRunsToday}/${allowance.allowedAutoRuns} today)`);
      continue;
    }
    const budget = Math.max(1, Number(settings.probeBudget) || 1200);
    if (config.command === 'publish' && await publishIsCurrent(env)) {
      await record(config, scheduledAt, 'skipped: already up to date');
      continue;
    }
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

async function publishIsCurrent(env: Env): Promise<boolean> {
  const [index, pool] = await Promise.all([
    getJson<{ generatedAt?: string }>(env, 'state/index.json'),
    getJson<{ generatedAt?: string }>(env, 'state/pool-stats.json'),
  ]);
  if (!index?.generatedAt || !pool?.generatedAt) return false;
  // EPG changes daily, so a publish older than two hours must still run even
  // when the line catalog itself has not changed.
  const recent = Date.now() - Date.parse(index.generatedAt) < 2 * 3_600_000;
  return recent && Date.parse(index.generatedAt) >= Date.parse(pool.generatedAt);
}

/**
 * Probe only updates the line pool. If the pool is newer than the published
 * catalog, publish automatically, but at most once every six hours so hourly
 * probes cannot exhaust the KV write budget.
 */
async function runAutoPublishAfterProbe(env: Env, settings: AppSettings, now: number): Promise<boolean> {
  if (!settings.autoPublishAfterProbeEnabled) return false;
  if ((await loadActionsAllowance(env, settings)).blocked) return false;
  const [index, pool, last, tasks] = await Promise.all([
    getJson<{ generatedAt?: string }>(env, 'state/index.json'),
    getJson<{ generatedAt?: string }>(env, 'state/pool-stats.json'),
    getRuntimeJson<{ at?: string }>(env, 'state/auto-publish-after-probe.json'),
    loadTasks(env),
  ]);
  if (!index?.generatedAt || !pool?.generatedAt) return false;
  if (Date.parse(pool.generatedAt) <= Date.parse(index.generatedAt)) return false;
  if (now - Date.parse(last?.at ?? '') < Math.max(1, Number(settings.autoPublishIntervalHours) || 6) * 3_600_000) return false;
  if (tasks.some((task: Task) => task.type === 'publish' && (task.status === 'queued' || task.status === 'running'))) return false;
  const task = await createTask(env, { type: 'publish', source: 'schedule', priority: 40, payload: { auto: 'after-probe' } });
  await putRuntimeJson(env, 'state/auto-publish-after-probe.json', { at: new Date(now).toISOString(), taskId: task.id });
  await audit(env, 'scheduler', 'schedule.auto-publish-after-probe', task.id);
  return true;
}

interface IntervalState {
  lastRunAt?: string;
  nextRunAt?: string;
  result?: string;
}

export interface ActionsAllowance {
  used: number;
  budget: number;
  reserve: number;
  remaining: number;
  daysLeft: number;
  runCost: number;
  autoRunsToday: number;
  allowedAutoRuns: number;
  blocked: boolean;
}

/**
 * How many automatic workflow runs may still start today so the monthly
 * Actions budget is spread evenly instead of being exhausted in the first
 * week. `blocked` also covers the hard floor (budget minus manual reserve).
 */
export function actionsAllowance(input: {
  used: number;
  budget: number;
  reserve: number;
  runCost: number;
  now: number;
  autoRunsToday: number;
}): ActionsAllowance {
  const used = Math.max(0, Math.floor(input.used));
  const budget = Math.max(1, Math.floor(input.budget));
  const reserve = Math.max(0, Math.min(budget, Math.floor(input.reserve)));
  const runCost = Math.max(1, Math.ceil(input.runCost));
  const remaining = Math.max(0, budget - reserve - used);
  const date = new Date(input.now);
  const daysInMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  const daysLeft = Math.max(1, daysInMonth - date.getUTCDate() + 1);
  const allowedAutoRuns = Math.floor(remaining / daysLeft / runCost);
  const autoRunsToday = Math.max(0, Math.floor(input.autoRunsToday));
  return {
    used,
    budget,
    reserve,
    remaining,
    daysLeft,
    runCost,
    autoRunsToday,
    allowedAutoRuns,
    blocked: remaining <= 0 || autoRunsToday >= allowedAutoRuns,
  };
}

async function loadActionsAllowance(env: Env, settings: AppSettings): Promise<ActionsAllowance> {
  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  const today = now.toISOString().slice(0, 10);
  const [usage, tasks] = await Promise.all([
    getRuntimeJson<{ github?: { month?: string; minutes?: number } }>(env, 'state/usage.json'),
    loadTasks(env),
  ]);
  const used = usage?.github?.month?.startsWith(month) ? Number(usage.github.minutes ?? 0) : 0;
  const autoRunsToday = tasks.filter(
    (task: Task) => task.source === 'schedule' && (task.createdAt ?? '').slice(0, 10) === today,
  ).length;
  return actionsAllowance({
    used,
    budget: Number(settings.actionsMonthlyBudgetMinutes ?? 2_000),
    reserve: Number(settings.actionsReserveMinutes ?? 300),
    runCost: Number(settings.actionsRunCostMinutes ?? 6),
    now: now.getTime(),
    autoRunsToday,
  });
}

async function intervalGuard(env: Env, settings: AppSettings): Promise<'quota' | 'running' | 'actions' | null> {
  const allowance = await loadActionsAllowance(env, settings);
  if (allowance.blocked) return 'actions';
  const today = new Date().toISOString().slice(0, 10);
  const usage = await getRuntimeJson<{ kv?: { day?: string; writes?: number } }>(env, 'state/usage.json');
  const writes = usage?.kv?.day === today ? Number(usage.kv.writes ?? 0) : 0;
  if (writes >= 920) return 'quota';
  const runs = (await workflowRunStatus(env)) as Array<{ status?: string; createdAt?: string }> | null;
  if (Array.isArray(runs)) {
    const now = Date.now();
    // A workflow stuck in_progress for hours must not block probing forever.
    const active = runs.some((run) => {
      if (run.status !== 'queued' && run.status !== 'in_progress') return false;
      const createdAt = run.createdAt ? Date.parse(run.createdAt) : NaN;
      return !Number.isFinite(createdAt) || now - createdAt < 45 * 60_000;
    });
    if (active) return 'running';
  }
  return null;
}

async function recordInterval(env: Env, key: string, now: number, nextMs: number, result: string): Promise<void> {
  const state: IntervalState = {
    lastRunAt: new Date(now).toISOString(),
    nextRunAt: new Date(nextMs).toISOString(),
    result,
  };
  await putRuntimeJson(env, key, state);
}

const PHASES = ['pending', 'quarantine'] as const;

function phaseList(value: string): string[] {
  return String(value ?? '').split(/[\s,，]+/).map((item) => item.trim()).filter((item) => (PHASES as readonly string[]).includes(item));
}

/** Weekly-ish fetch task, independent from daily publish/probe. */
async function runFetchWatch(env: Env, settings: AppSettings, now: number): Promise<boolean> {
  if (!settings.autoFetchEnabled) return false;
  const state = await getRuntimeJson<IntervalState>(env, 'state/fetch-schedule.json');
  if (state?.nextRunAt && Date.parse(state.nextRunAt) > now) return false;
  const intervalMs = Math.max(1, Number(settings.fetchIntervalDays) || 7) * 86_400_000;
  const guard = await intervalGuard(env, settings);
  if (guard) {
    const delay = guard === 'actions' ? 6 * 3_600_000 : 30 * 60_000;
    await recordInterval(env, 'state/fetch-schedule.json', now, now + delay, `skipped: ${guard}`);
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
  const state = await getRuntimeJson<IntervalState>(env, 'state/probe-schedule.json');
  if (state?.nextRunAt && Date.parse(state.nextRunAt) > now) return false;
  const intervalMs = Math.max(1, Number(settings.autoProbeIntervalHours) || 2) * 3_600_000;
  const stats = await getJson<Record<string, number>>(env, 'state/pool-stats.json');
  const paused = new Set(phaseList(settings.probePausedPhases));
  const hasWork = !stats || PHASES.some((phase) => !paused.has(phase) && Number(stats[phase] ?? 0) > 0);
  if (!hasWork) {
    await recordInterval(env, 'state/probe-schedule.json', now, now + intervalMs, 'idle: no due lines');
    return false;
  }

  const guard = await intervalGuard(env, settings);
  if (guard) {
    const delay = guard === 'actions' ? 6 * 3_600_000 : 15 * 60_000;
    await recordInterval(env, 'state/probe-schedule.json', now, now + delay, `skipped: ${guard}`);
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
