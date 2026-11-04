import type { Env } from '../env.js';
import { getJson } from './store.js';
import { getRuntimeJson, putRuntimeJson } from './runtime-state.js';
import { dispatchWorkflow, listWorkflowRuns } from './github.js';

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
  const owner = crypto.randomUUID();
  let executed = false;
  try {
    await ensureLockTable(env);
    for (let attempt = 0; attempt < 40; attempt++) {
      const now = Date.now();
      const result = await env.DB.prepare(
        `INSERT INTO task_locks (id, owner, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
         WHERE task_locks.expires_at < ?`,
      )
        .bind(LOCK_ID, owner, now + LOCK_TTL_MS, now)
        .run();
      if (Number((result.meta as { changes?: number }).changes ?? 0) > 0) {
        executed = true;
        try {
          return await fn();
        } finally {
          await env.DB.prepare('DELETE FROM task_locks WHERE id = ? AND owner = ?').bind(LOCK_ID, owner).run().catch(() => undefined);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 50));
    }
  } catch (error) {
    if (executed) throw error;
    console.error('task lock failed, falling back to unlocked mutation', error);
    return fn();
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
  const nextRetry = (task.retryCount ?? 0) + 1;
  if (nextRetry > MAX_RETRIES) {
    task.status = 'failed';
    task.message = `${reason}，重试次数已用尽`;
    task.finishedAt = new Date().toISOString();
    return null;
  }
  const index = tasks.findIndex((item) => item.id === task.id);
  if (index >= 0) tasks.splice(index, 1);
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
        if (!retry) await notifyTaskFailure(env, task, task.message);
      }
      continue;
    }
    task.githubRunId = run.id;
    if (run.status === 'completed') {
      if (run.conclusion === 'success') task.lastHeartbeatAt = new Date().toISOString();
      else {
        const retry = retryTask(tasks, task, `GitHub run ${run.conclusion ?? '失败'}`);
        if (!retry) await notifyTaskFailure(env, task, task.message);
      }
    } else if (run.status === 'queued' && age > 15 * 60_000) {
      const retry = retryTask(tasks, task, 'GitHub run 排队超时');
      if (!retry) await notifyTaskFailure(env, task, task.message);
    } else {
      task.lastHeartbeatAt = new Date().toISOString();
    }
  }
}

async function finishTaskCore(env: Env, taskId: string, status: 'done' | 'failed', message?: string): Promise<void> {
  const tasks = await loadTasks(env);
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return;
  task.status = status;
  const taskMessage = status === 'done'
    ? (message ?? (/抓取完成|分批探测完成/.test(task.message ?? '') ? task.message! : '完成'))
    : (message ?? '失败');
  task.message = taskMessage;
  if (status === 'done' && task.progress.total > 0) task.progress.done = task.progress.total;
  task.finishedAt = new Date().toISOString();
  if (status === 'done' && task.type === 'publish') {
    await putRuntimeJson(env, 'state/auto-publish-after-probe.json', { at: task.finishedAt, taskId: task.id });
  }
  if (status === 'failed' && (task.retryCount ?? 0) < MAX_RETRIES && isTransientFailure(taskMessage)) {
    const retry = retryTask(tasks, task, taskMessage);
    await saveTasks(env, tasks);
    if (retry) await notifyTaskFailure(env, retry, `任务失败，已自动重试：${taskMessage}`);
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
    return { task: running, message: '已有任务在运行' };
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
  const usage = await getRuntimeJson<{ kv?: { day?: string; writes?: number } }>(env, 'state/usage.json');
  const writes = usage?.kv?.day === today ? Number(usage.kv.writes ?? 0) : 0;
  if (writes >= 920) {
    if (changed) await saveTasks(env, tasks);
    return { task: next, message: `KV 写入 ${writes}/1000，任务保持排队` };
  }

  next.status = 'running';
  next.startedAt = new Date().toISOString();
  next.lastHeartbeatAt = next.startedAt;
  await saveTasks(env, tasks);

  const result = await dispatchWorkflow(env, {
    command: next.type,
    task_id: next.id,
    force: next.payload.force ?? 'false',
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
  } else {
    next.message = '已派发';
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
    if (task.status === 'running') return '运行中的任务不能取消，请等它结束';
    task.status = 'cancelled';
    task.finishedAt = new Date().toISOString();
    task.message = '已取消';
  } else if (action === 'force-fail') {
    if (task.status !== 'running') return '只有运行中的任务可以强制结束';
    task.status = 'failed';
    task.finishedAt = new Date().toISOString();
    task.message = '手动强制结束';
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
