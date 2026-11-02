import type { Env } from '../env.js';
import { getJson } from './store.js';
import { dispatchWorkflow } from './github.js';

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
}

const KEY = 'state/tasks.json';
const MAX_FINISHED = 30;
const STALE_MS = 45 * 60_000;
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

export async function loadTasks(env: Env): Promise<Task[]> {
  return (await getJson<Task[]>(env, KEY)) ?? [];
}

async function saveTasks(env: Env, tasks: Task[]): Promise<void> {
  const active = tasks.filter((task) => task.status === 'queued' || task.status === 'running' || task.status === 'paused');
  const finished = tasks
    .filter((task) => task.status === 'done' || task.status === 'failed' || task.status === 'cancelled')
    .sort((a, b) => (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt))
    .slice(0, MAX_FINISHED);
  await env.KV.put(KEY, JSON.stringify([...active, ...finished]));
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

async function finishTaskCore(env: Env, taskId: string, status: 'done' | 'failed', message?: string): Promise<void> {
  const tasks = await loadTasks(env);
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return;
  task.status = status;
  task.message = status === 'done' ? (message ?? '完成') : (message ?? '失败');
  if (status === 'done' && task.progress.total > 0) task.progress.done = task.progress.total;
  task.finishedAt = new Date().toISOString();
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
  task.progress.done = Math.max(0, done);
  if (total && total > 0) task.progress.total = total;
  if (message) task.message = message;
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
  for (const task of tasks) {
    if (task.status === 'running' && task.startedAt && now - Date.parse(task.startedAt) > STALE_MS) {
      task.status = 'failed';
      task.message = '超时未完成，自动释放队列';
      task.finishedAt = new Date().toISOString();
      changed = true;
    }
  }
  const running = tasks.find((task) => task.status === 'running');
  if (running) {
    if (changed) await saveTasks(env, tasks);
    return { task: running, message: '已有任务在运行' };
  }
  const queued = tasks
    .filter((task) => task.status === 'queued')
    .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  const next = queued[0];
  if (!next) {
    if (changed) await saveTasks(env, tasks);
    return { message: '队列为空' };
  }

  // Global quota guard: keep the task queued instead of burning a dispatch.
  const today = new Date().toISOString().slice(0, 10);
  const usage = await getJson<{ kv?: { day?: string; writes?: number } }>(env, 'state/usage.json');
  const writes = usage?.kv?.day === today ? Number(usage.kv.writes ?? 0) : 0;
  if (writes >= 920) {
    if (changed) await saveTasks(env, tasks);
    return { task: next, message: `KV 写入 ${writes}/1000，任务保持排队` };
  }

  next.status = 'running';
  next.startedAt = new Date().toISOString();
  await saveTasks(env, tasks);

  const result = await dispatchWorkflow(env, {
    command: next.type,
    task_id: next.id,
    force: next.payload.force ?? 'false',
    budget: next.payload.budget ?? '',
    source_id: next.payload.source_id ?? '',
    line_keys: next.payload.line_keys ?? '',
    phase: next.payload.phase ?? '',
  });
  if (!result.ok) {
    next.status = 'failed';
    next.message = result.message;
    next.finishedAt = new Date().toISOString();
  } else {
    next.message = '已派发';
  }
  await saveTasks(env, tasks);
  if (!result.ok) await notifyTaskFailure(env, next, result.message);
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
