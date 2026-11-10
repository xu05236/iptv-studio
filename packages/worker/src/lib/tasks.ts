import type { AppSettings } from '@iptv/core';
import { DEFAULT_SETTINGS } from '@iptv/core';
import type { Env } from '../env.js';
import { getJson } from './store.js';
import { getRuntimeJson, putRuntimeJson } from './runtime-state.js';
import { cancelGithubRun, dispatchWorkflow, listWorkflowRuns } from './github.js';
import { deletePlaceholderRun, finishPlaceholderRun, loadSettings, upsertPlaceholderRun } from '../db.js';

export type TaskSource = 'schedule' | 'manual' | 'detection' | 'source' | 'cli';
export type TaskStatus = 'scheduled' | 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled';

export interface Task {
  id: string;
  type: string;
  source: TaskSource;
  status: TaskStatus;
  priority: number;
  payload: Record<string, string>;
  progress: { done: number; total: number; unit: string };
  message?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  runId?: string;
  lastHeartbeatAt?: string;
  retryCount?: number;
  githubRunId?: number;
}

const KEY = 'state/tasks.json';
const MAX_FINISHED = 30;
const MAX_RETRIES = 2;
const WATCHDOG_MS: Record<string, number> = {
  collect: 30 * 60_000,
  fetch: 15 * 60_000,
  publish: 10 * 60_000,
  probe: 10 * 60_000,
  'probe-batch': 10 * 60_000,
  'probe-lines': 15 * 60_000,
  epg: 10 * 60_000,
  export: 10 * 60_000,
  liveness: 15 * 60_000,
  'cleanup-orphans': 10 * 60_000,
};
const LOCK_ID = 'queue';
const LOCK_TTL_MS = 60_000;

let lockTableReady: Promise<void> | null = null;

function ensureLockTable(env: Env): Promise<void> {
  if (!env.DB) return Promise.resolve();
  if (!lockTableReady) {
    lockTableReady = env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS task_locks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL)',
    )
      .run()
      .then(() => undefined)
      .catch((error) => {
        lockTableReady = null;
        throw error;
      });
  }
  return lockTableReady;
}

/**
 * Serialize queue mutations with a short D1 lease. KV has no CAS, so the lease
 * is the only cross-isolate way to prevent two requests from overwriting the
 * same task list. If D1 is unavailable we still run (availability over locking).
 */
async function withTaskLock<T>(env: Env, fn: () => Promise<T>): Promise<T> {
  if (!env.DB) return fn();
  const db = env.DB;
  const owner = crypto.randomUUID();
  let executed = false;
  try {
    await ensureLockTable(env);
    for (let attempt = 0; attempt < 40; attempt++) {
      const now = Date.now();
      const result = await db.prepare(
        `INSERT INTO task_locks (id, owner, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
         WHERE task_locks.expires_at < ?`,
      )
        .bind(LOCK_ID, owner, now + LOCK_TTL_MS, now)
        .run();
      if (Number((result.meta as { changes?: number }).changes ?? 0) > 0) {
        executed = true;
        // Renew while the mutation runs: dispatching a workflow or a slow D1
        // call can exceed the 60s lease, which used to let a second request in
        // and overwrite the queue.
        const renewal = setInterval(() => {
          void db.prepare('UPDATE task_locks SET expires_at = ? WHERE id = ? AND owner = ?')
            .bind(Date.now() + LOCK_TTL_MS, LOCK_ID, owner)
            .run()
            .catch(() => undefined);
        }, Math.max(5_000, Math.floor(LOCK_TTL_MS / 3)));
        try {
          return await fn();
        } finally {
          clearInterval(renewal);
          await db.prepare('DELETE FROM task_locks WHERE id = ? AND owner = ?').bind(LOCK_ID, owner).run().catch(() => undefined);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 50));
    }
  } catch (error) {
    if (executed) throw error;
    // Locking is not optional: mutating the shared task list unlocked is what
    // duplicates/drops tasks under load. Fail closed and let the caller retry.
    console.error('task lock failed', error);
    throw new Error('任务队列暂不可用（排队锁获取失败），请稍后重试');
  }
  throw new Error('任务队列繁忙，请稍后重试');
}

let taskStateReady: Promise<void> | null = null;
function ensureTaskState(env: Env): Promise<void> {
  if (!taskStateReady) {
    taskStateReady = env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS task_state (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
    ).run().then(() => undefined).catch((error) => {
      taskStateReady = null;
      throw error;
    });
  }
  return taskStateReady;
}

export async function loadTasks(env: Env): Promise<Task[]> {
  try {
    await ensureTaskState(env);
    const row = await env.DB.prepare('SELECT payload FROM task_state WHERE id = ?').bind('default').first<{ payload: string }>();
    if (!row?.payload) return [];
    return JSON.parse(row.payload) as Task[];
  } catch {
    // Tests and older deployments may not have D1 bindings; keep the legacy
    // KV queue working as a fallback.
    return (await getJson<Task[]>(env, KEY)) ?? [];
  }
}

async function saveTasks(env: Env, tasks: Task[]): Promise<void> {
  // Merge with current D1 rows first: a stale caller must not erase a task
  // another request just created, finished, or scheduled.
  const existing = await loadTasks(env);
  const merged = new Map(existing.map((task) => [task.id, task]));
  for (const task of tasks) merged.set(task.id, task);
  const all = [...merged.values()];
  const active = all.filter((task) => task.status === 'queued' || task.status === 'running' || task.status === 'paused' || task.status === 'scheduled');
  const finished = all
    .filter((task) => task.status === 'done' || task.status === 'failed' || task.status === 'cancelled')
    .sort((a, b) => (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt))
    .slice(0, MAX_FINISHED);
  try {
    await ensureTaskState(env);
    await env.DB.prepare(
      "INSERT INTO task_state (id, payload, updated_at) VALUES ('default', ?, datetime('now')) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = datetime('now')",
    ).bind(JSON.stringify([...active, ...finished])).run();
  } catch {
    await env.KV.put(KEY, JSON.stringify([...active, ...finished]));
  }
}

/** Drop failed task records so stale, already-fixed failures stop cluttering the board. */
export async function deleteFailedTasks(env: Env, olderThanMs = 0): Promise<number> {
  return withTaskLock(env, async () => {
    const tasks = await loadTasks(env);
    const cutoff = Date.now() - olderThanMs;
    const kept = tasks.filter((task) => {
      if (task.status !== 'failed') return true;
      const finished = task.finishedAt ? Date.parse(task.finishedAt) : 0;
      return finished > cutoff;
    });
    const removed = tasks.length - kept.length;
    if (removed) await saveTasks(env, kept);
    return removed;
  });
}

export async function recordFinishedTask(
  env: Env,
  input: { type: string; source: TaskSource; message: string; payload?: Record<string, string>; total?: number },
): Promise<Task> {
  return withTaskLock(env, async () => {
    const tasks = await loadTasks(env);
    const now = new Date().toISOString();
    const task: Task = {
      id: `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      type: input.type,
      source: input.source,
      status: 'done',
      priority: 50,
      payload: input.payload ?? {},
      progress: { done: input.total ?? 1, total: input.total ?? 1, unit: '' },
      message: input.message,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
      lastHeartbeatAt: now,
    };
    tasks.push(task);
    await saveTasks(env, tasks);
    return task;
  });
}

async function createTaskCore(
  env: Env,
  input: { type: string; source: TaskSource; priority?: number; payload?: Record<string, string>; total?: number; unit?: string; message?: string },
): Promise<Task> {
  const tasks = await loadTasks(env);
  // Scheduled tasks are deduplicated: one active task per type+phase.
  if (input.source === 'schedule') {
    const phase = input.payload?.phase ?? '';
    const duplicate = tasks.find(
      (task) => task.type === input.type && task.source === 'schedule' && task.status !== 'done' && task.status !== 'failed' && task.status !== 'cancelled' && (task.payload.phase ?? '') === phase,
    );
    if (duplicate) return duplicate;
  }
  const task: Task = {
    id: `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type: input.type,
    source: input.source,
    status: 'queued',
    priority: input.priority ?? (input.source === 'manual' || input.source === 'detection' ? 100 : input.source === 'source' ? 80 : 50),
    payload: input.payload ?? {},
    progress: { done: 0, total: Math.max(0, input.total ?? 0), unit: input.unit ?? '' },
    message: input.message,
    createdAt: new Date().toISOString(),
  };
  tasks.push(task);
  await saveTasks(env, tasks);
  return task;
}

export function createTask(...args: Parameters<typeof createTaskCore>): ReturnType<typeof createTaskCore> {
  return withTaskLock(args[0], () => createTaskCore(...args));
}

async function updateTaskCore(env: Env, id: string, patch: Partial<Task>): Promise<Task | null> {
  const tasks = await loadTasks(env);
  const index = tasks.findIndex((task) => task.id === id);
  if (index < 0) return null;
  tasks[index] = { ...tasks[index]!, ...patch };
  await saveTasks(env, tasks);
  return tasks[index]!;
}

export function updateTask(...args: Parameters<typeof updateTaskCore>): ReturnType<typeof updateTaskCore> {
  return withTaskLock(args[0], () => updateTaskCore(...args));
}

async function notifyTaskFailure(env: Env, task: Task, message?: string): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `❌ IPTV 任务失败\n来源：${task.source}\n类型：${task.type}\n${message ?? task.message ?? ''}`,
      }),
    });
  } catch {
    // Notification must never affect task completion.
  }
}

/** True for failures that are likely to succeed on a retry. */
function isTransientFailure(message: string): boolean {
  return /timeout|timed out|ETIMEDOUT|ECONN|network|fetch failed|502|503|504|超时|连接|服务器|rate limit|no run|未找到 GitHub run/i.test(message);
}

/** Remove a failed task and enqueue a fresh attempt with the same payload. */
function retryTask(tasks: Task[], task: Task, reason: string): Task | null {
  if (task.status === 'cancelled') return null;
  const nextRetry = (task.retryCount ?? 0) + 1;
  if (nextRetry > MAX_RETRIES) {
    task.status = 'failed';
    task.message = `${reason}，重试次数已用尽`;
    task.finishedAt = new Date().toISOString();
    return null;
  }
  const retry: Task = {
    ...task,
    id: `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    status: 'queued',
    progress: { done: 0, total: task.progress.total, unit: task.progress.unit },
    message: `自动重试 ${nextRetry}/${MAX_RETRIES}：${reason}`,
    createdAt: new Date().toISOString(),
    startedAt: undefined,
    finishedAt: undefined,
    lastHeartbeatAt: undefined,
    githubRunId: undefined,
    retryCount: nextRetry,
  };
  // Keep the old task (as cancelled) instead of splicing it out: saveTasks
  // merges with the persisted list, so a removed running task was written back
  // and looked "running" forever while a fresh retry sat in the queue.
  task.status = 'cancelled';
  task.finishedAt = new Date().toISOString();
  task.message = `已由重试任务接替（${nextRetry}/${MAX_RETRIES}）：${reason}`;
  tasks.push(retry);
  return retry;
}

/** Match running tasks to their GitHub run and release heartbeat-only stalls. */
async function reconcileRunningTasks(env: Env, tasks: Task[]): Promise<void> {
  const running = tasks.filter((task) => task.status === 'running');
  if (!running.length) return;
  const runs = await listWorkflowRuns(env);
  if (!runs.length) return;
  const now = Date.now();
  for (const task of [...running]) {
    const age = now - Date.parse(task.startedAt ?? task.createdAt);
    if (age < 2 * 60_000) continue;
    const run = runs.find((candidate) => `${candidate.name ?? ''} ${candidate.display_title ?? ''}`.includes(task.id));
    if (!run) {
      if (age > 10 * 60_000) {
        const retry = retryTask(tasks, task, '未找到 GitHub run');
        if (retry) await deletePlaceholderRun(env, task.id);
        else {
          await finishPlaceholderRun(env, task.id, 'failed', task.message);
          await notifyTaskFailure(env, task, task.message);
        }
      }
      continue;
    }
    task.githubRunId = run.id;
    if (run.status === 'completed') {
      if (run.conclusion === 'success') task.lastHeartbeatAt = new Date().toISOString();
      else if (run.conclusion === 'cancelled') {
        // A cancelled run means someone stopped it on purpose (the task board
        // or the GitHub UI). Retrying here would quietly start another Actions
        // run and burn minutes — the exact thing the operator tried to stop.
        task.status = 'cancelled';
        task.finishedAt = new Date().toISOString();
        task.message = 'GitHub run 已取消，不再自动重试';
        await finishPlaceholderRun(env, task.id, 'cancelled', task.message);
      } else {
        const retry = retryTask(tasks, task, `GitHub run ${run.conclusion ?? '失败'}`);
        if (retry) await deletePlaceholderRun(env, task.id);
        else {
          await finishPlaceholderRun(env, task.id, 'failed', task.message);
          await notifyTaskFailure(env, task, task.message);
        }
      }
    } else if (run.status === 'queued' && age > 15 * 60_000) {
      const retry = retryTask(tasks, task, 'GitHub run 排队超时');
      if (retry) await deletePlaceholderRun(env, task.id);
      else {
        await finishPlaceholderRun(env, task.id, 'failed', task.message);
        await notifyTaskFailure(env, task, task.message);
      }
    } else {
      task.lastHeartbeatAt = new Date().toISOString();
    }
  }
}

async function finishTaskCore(env: Env, taskId: string, status: 'done' | 'failed', message?: string): Promise<void> {
  const tasks = await loadTasks(env);
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return;
  // Late finish from a run the operator already cancelled: keep it cancelled.
  if (task.status === 'cancelled') return;
  task.status = status;
  const taskMessage = status === 'done'
    ? (message ?? (/抓取完成|分批探测完成|EPG 刷新完成|快照完成/.test(task.message ?? '') ? task.message! : '完成'))
    : (message ?? '失败');
  task.message = taskMessage;
  if (status === 'done' && task.progress.total > 0) task.progress.done = task.progress.total;
  task.finishedAt = new Date().toISOString();
  await finishPlaceholderRun(env, taskId, status === 'failed' ? 'failed' : 'success', taskMessage);
  if (status === 'done' && task.type === 'publish') {
    await putRuntimeJson(env, 'state/auto-publish-after-probe.json', { at: task.finishedAt, taskId: task.id });
  }
  if (status === 'failed' && (task.retryCount ?? 0) < MAX_RETRIES && isTransientFailure(taskMessage)) {
    const retry = retryTask(tasks, task, taskMessage);
    await saveTasks(env, tasks);
    if (retry) {
      await deletePlaceholderRun(env, task.id);
      await notifyTaskFailure(env, retry, `任务失败，已自动重试：${taskMessage}`);
    } else {
      await notifyTaskFailure(env, task, task.message);
    }
    return;
  }
  await saveTasks(env, tasks);
  if (status === 'failed') await notifyTaskFailure(env, task, task.message);
}

export function finishTask(...args: Parameters<typeof finishTaskCore>): ReturnType<typeof finishTaskCore> {
  return withTaskLock(args[0], () => finishTaskCore(...args));
}

async function progressTaskCore(env: Env, taskId: string, done: number, total?: number, message?: string): Promise<void> {
  const tasks = await loadTasks(env);
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return;
  if (task.status === 'cancelled') return;
  const nextTotal = total && total > 0 ? total : task.progress.total;
  if (task.progress.done === Math.max(0, done) && task.progress.total === nextTotal && (!message || task.message === message)) return;
  task.progress.done = Math.max(0, done);
  if (total && total > 0) task.progress.total = total;
  if (message) task.message = message;
  task.lastHeartbeatAt = new Date().toISOString();
  await saveTasks(env, tasks);
}

export function progressTask(...args: Parameters<typeof progressTaskCore>): ReturnType<typeof progressTaskCore> {
  return withTaskLock(args[0], () => progressTaskCore(...args));
}

/** Dispatch the highest-priority queued task when nothing is running. */
async function dispatchNextCore(env: Env): Promise<{ task?: Task; message: string }> {
  const tasks = await loadTasks(env);
  const now = Date.now();
  let changed = false;
  await reconcileRunningTasks(env, tasks);
  changed = true;
  const retryFailed: Task[] = [];
  const retried: Task[] = [];
  for (const task of [...tasks]) {
    if (task.status !== 'running') continue;
    const last = Date.parse(task.lastHeartbeatAt ?? task.startedAt ?? task.createdAt);
    const limit = WATCHDOG_MS[task.type] ?? 15 * 60_000;
    if (now - last > limit) {
      const retry = retryTask(tasks, task, `${Math.max(1, Math.round((now - last) / 60_000))} 分钟无心跳`);
      if (retry) retried.push(retry);
      else retryFailed.push(task);
      changed = true;
    }
  }
  const notify = async (): Promise<void> => {
    for (const task of retried) await notifyTaskFailure(env, task, task.message);
    for (const task of retryFailed) await notifyTaskFailure(env, task, task.message);
  };
  const running = tasks.find((task) => task.status === 'running');
  if (running) {
    if (changed) await saveTasks(env, tasks);
    await notify();
    return { task: running, message: '已有任务在运行，任务已加入排队中' };
  }
  const queued = tasks
    .filter((task) => task.status === 'queued')
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  const next = queued[0];
  if (!next) {
    if (changed) await saveTasks(env, tasks);
    await notify();
    return { message: '队列为空' };
  }

  // Global quota guard: keep the task queued instead of burning a dispatch.
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const usage = await getRuntimeJson<{
    kv?: { day?: string; writes?: number };
    d1?: { day?: string; rowsWritten?: number };
    github?: { month?: string; minutes?: number };
  }>(env, 'state/usage.json');
  const writes = usage?.kv?.day === today ? Number(usage.kv.writes ?? 0) : 0;
  if (writes >= 920) {
    if (changed) await saveTasks(env, tasks);
    return { task: next, message: `KV 写入 ${writes}/1000，任务保持排队` };
  }
  const d1Writes = usage?.d1?.day === today ? Number(usage.d1.rowsWritten ?? 0) : 0;
  if (d1Writes >= 90_000) {
    if (changed) await saveTasks(env, tasks);
    return { task: next, message: `D1 今日已写入 ${d1Writes}/100000 行，任务保持排队` };
  }
  const ghMinutes = usage?.github?.month?.startsWith(month) ? Number(usage.github.minutes ?? 0) : 0;
  let settings: AppSettings = DEFAULT_SETTINGS;
  try {
    settings = await loadSettings(env);
  } catch {
    // A settings read failure must not break the queue; fall back to defaults.
    settings = DEFAULT_SETTINGS;
  }
  const budgetMinutes = Math.max(0, Number(settings.actionsMonthlyBudgetMinutes ?? 2_000));
  const reserveMinutes = Math.max(0, Number(settings.actionsReserveMinutes ?? 300));
  const autoBudget = Math.max(0, budgetMinutes - reserveMinutes);
  if (ghMinutes >= autoBudget && next.source !== 'manual') {
    if (changed) await saveTasks(env, tasks);
    return { task: next, message: `GitHub Actions 本月已用 ${ghMinutes}/${budgetMinutes} 分钟（保留 ${reserveMinutes} 分钟手动额度），自动任务保持排队（可手动触发）` };
  }
  const scheduledToday = tasks.filter(
    (task) => task.source === 'schedule' && (task.createdAt ?? '').slice(0, 10) === today,
  ).length;
  if (next.source === 'schedule' && scheduledToday >= 20) {
    if (changed) await saveTasks(env, tasks);
    return { task: next, message: `今日自动派发已达 ${scheduledToday}/20 次，任务保持排队` };
  }

  next.status = 'running';
  next.startedAt = new Date().toISOString();
  next.lastHeartbeatAt = next.startedAt;
  await saveTasks(env, tasks);

  const result = await dispatchWorkflow(env, {
    command: next.type,
    task_id: next.id,
    force: next.payload.force ?? 'false',
    force_fetch: next.payload.force_fetch ?? 'false',
    budget: next.payload.budget ?? '',
    source_id: next.payload.source_id ?? '',
    line_keys: next.payload.line_keys ?? '',
    phase: next.payload.phase ?? '',
    auto_publish: next.payload.auto ? 'true' : '',
    trigger: next.source,
  });
  if (!result.ok) {
    next.status = 'failed';
    next.message = result.message;
    next.finishedAt = new Date().toISOString();
    await upsertPlaceholderRun(env, { taskId: next.id, trigger: next.source, status: 'failed', error: result.message });
  } else {
    next.message = '已派发';
    next.runId = `task:${next.id}`;
    await upsertPlaceholderRun(env, { taskId: next.id, trigger: next.source, status: 'running' });
  }
  next.lastHeartbeatAt = new Date().toISOString();
  await saveTasks(env, tasks);
  if (!result.ok) await notifyTaskFailure(env, next, result.message);
  await notify();
  return { task: next, message: result.ok ? '已派发' : result.message };
}

export function dispatchNext(...args: Parameters<typeof dispatchNextCore>): ReturnType<typeof dispatchNextCore> {
  return withTaskLock(args[0], () => dispatchNextCore(...args));
}

/**
 * Quick actions from the task board. Returns a short user-facing message.
 */
async function mutateTaskCore(env: Env, id: string, action: string): Promise<string> {
  const tasks = await loadTasks(env);
  const task = tasks.find((item) => item.id === id);
  if (!task) return '任务不存在';

  if (action === 'pause') {
    if (task.status !== 'queued') return '只有排队中的任务可以暂停';
    task.status = 'paused';
    task.message = '已暂停';
  } else if (action === 'resume') {
    if (task.status !== 'paused') return '任务未暂停';
    task.status = 'queued';
    task.message = '已恢复';
  } else if (action === 'cancel') {
    if (task.status === 'running') await cancelGithubRun(env, task.githubRunId);
    task.status = 'cancelled';
    task.finishedAt = new Date().toISOString();
    task.message = '已取消';
    await finishPlaceholderRun(env, task.id, 'cancelled', '已取消');
  } else if (action === 'auto-fail') {
    if (task.status !== 'running') return '只有运行中的任务可以自动结束';
    await cancelGithubRun(env, task.githubRunId);
    task.status = 'failed';
    task.finishedAt = new Date().toISOString();
    task.message = '自动结束：运行超过 20 分钟无进展';
    await finishPlaceholderRun(env, task.id, 'failed', task.message);
  } else if (action === 'force-fail') {
    if (task.status !== 'running') return '只有运行中的任务可以强制结束';
    await cancelGithubRun(env, task.githubRunId);
    task.status = 'failed';
    task.finishedAt = new Date().toISOString();
    task.message = '手动强制结束';
    await finishPlaceholderRun(env, task.id, 'failed', task.message);
  } else if (action === 'run-now') {
    if (task.status === 'running') return '任务已在运行';
    task.status = 'queued';
    task.priority = 999;
    task.message = '已提升到队首';
  } else if (action === 'move-up' || action === 'move-down') {
    const queued = tasks.filter((item) => item.status === 'queued').sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
    const index = queued.findIndex((item) => item.id === id);
    if (index < 0) return '只有排队中的任务可以排序';
    const target = action === 'move-up' ? index - 1 : index + 1;
    if (target < 0 || target >= queued.length) return '已经在边界';
    [queued[index], queued[target]] = [queued[target]!, queued[index]!];
    queued.forEach((item, position) => { item.priority = 100 - position; });
  } else if (action === 'retry') {
    if (task.status !== 'failed' && task.status !== 'cancelled') return '只有失败/取消的任务可以重试';
    task.status = 'queued';
    task.priority = 30;
    task.progress.done = 0;
    task.finishedAt = undefined;
    task.message = '已重新入队';
    await deletePlaceholderRun(env, task.id);
  } else {
    return '未知操作';
  }
  await saveTasks(env, tasks);
  if (action === 'run-now' || action === 'resume' || action === 'retry') await dispatchNextCore(env);
  return '已更新';
}

export function mutateTask(...args: Parameters<typeof mutateTaskCore>): ReturnType<typeof mutateTaskCore> {
  return withTaskLock(args[0], () => mutateTaskCore(...args));
}
