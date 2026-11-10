import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.js';

vi.mock('../src/lib/github.js', () => ({
  dispatchWorkflow: vi.fn(async () => ({ ok: true, message: 'ok' })),
  listWorkflowRuns: vi.fn(async () => []),
}));

import { dispatchWorkflow } from '../src/lib/github.js';
import { createTask, dispatchNext, finishTask, loadTasks, mutateTask, progressTask } from '../src/lib/tasks.js';

function makeEnv(): Env {
  const store = new Map<string, string>();
  return {
    KV: {
      async get(key: string, type?: string) {
        const value = store.get(key);
        if (!value) return null;
        return type === 'json' ? JSON.parse(value) : value;
      },
      async put(key: string, value: string) {
        store.set(key, value);
      },
    },
  } as unknown as Env;
}

beforeEach(() => {
  vi.mocked(dispatchWorkflow).mockClear();
});

describe('task queue', () => {
  it('assigns source priorities and dedupes scheduled slots', async () => {
    const env = makeEnv();
    const manual = await createTask(env, { type: 'publish', source: 'manual' });
    const source = await createTask(env, { type: 'fetch', source: 'source' });
    const scheduled = await createTask(env, { type: 'probe-batch', source: 'schedule', payload: { phase: 'pending' } });
    const duplicate = await createTask(env, { type: 'probe-batch', source: 'schedule', payload: { phase: 'pending' } });
    expect(manual.priority).toBe(100);
    expect(source.priority).toBe(80);
    expect(scheduled.priority).toBe(50);
    expect(duplicate.id).toBe(scheduled.id);
  });

  it('runs the highest-priority queued task and keeps one running', async () => {
    const env = makeEnv();
    await createTask(env, { type: 'fetch', source: 'schedule' });
    const manual = await createTask(env, { type: 'publish', source: 'manual' });
    const result = await dispatchNext(env);
    expect(result.task?.id).toBe(manual.id);
    expect(result.task?.status).toBe('running');
    expect(dispatchWorkflow).toHaveBeenCalledTimes(1);

    const again = await dispatchNext(env);
    expect(again.message).toContain('已有任务');
    expect(dispatchWorkflow).toHaveBeenCalledTimes(1);
  });

  it('pauses, resumes and cancels queued tasks', async () => {
    const env = makeEnv();
    const task = await createTask(env, { type: 'fetch', source: 'manual' });
    await mutateTask(env, task.id, 'pause');
    expect((await loadTasks(env))[0]?.status).toBe('paused');
    await mutateTask(env, task.id, 'resume');
    // Resume puts it back in the queue and dispatchNext starts it immediately.
    expect((await loadTasks(env))[0]?.status).toBe('running');
    await finishTask(env, task.id, 'done');

    const second = await createTask(env, { type: 'fetch', source: 'manual' });
    await mutateTask(env, second.id, 'pause');
    await mutateTask(env, second.id, 'cancel');
    expect((await loadTasks(env)).find((item) => item.id === second.id)?.status).toBe('cancelled');
  });

  it('marks completion and stores probe progress', async () => {
    const env = makeEnv();
    const task = await createTask(env, { type: 'probe-batch', source: 'manual', total: 1200, unit: 'lines' });
    await progressTask(env, task.id, 600, 1200);
    await finishTask(env, task.id, 'done');
    const stored = (await loadTasks(env))[0]!;
    expect(stored.status).toBe('done');
    expect(stored.progress.done).toBe(1200);
    expect(stored.message).toBe('完成');
  });

  it('marks the timed-out task cancelled instead of resurrecting it after a retry', async () => {
    const env = makeEnv();
    const task = await createTask(env, { type: 'fetch', source: 'manual' });
    await dispatchNext(env);
    // Rewind the heartbeat so the watchdog sees a stall.
    const stale = Date.now() - 60 * 60_000;
    const stored = JSON.parse((await env.KV.get('state/tasks.json')) as string) as Array<{ id: string; lastHeartbeatAt?: string; startedAt?: string }>;
    for (const item of stored) {
      item.startedAt = new Date(stale).toISOString();
      item.lastHeartbeatAt = new Date(stale).toISOString();
    }
    await env.KV.put('state/tasks.json', JSON.stringify(stored));

    const result = await dispatchNext(env);
    const tasks = await loadTasks(env);
    const old = tasks.find((item) => item.id === task.id)!;
    expect(old.status).toBe('cancelled');
    expect(old.message).toContain('已由重试任务接替');
    // The retry is running now; the key assertion is that the old task is not
    // still "running" (which used to make dispatch skip every fresh task).
    expect(result.task?.id).not.toBe(task.id);
    expect(tasks.filter((item) => item.status === 'running')).toHaveLength(1);
  });
});
