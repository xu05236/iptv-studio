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
});
