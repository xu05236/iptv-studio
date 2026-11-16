import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { adminCache } from '../src/lib/adminCache.js';
import type { AppEnv } from '../src/env.js';

const store = new Map<string, Response>();

function installFakeCaches() {
  const fake = {
    default: {
      match: async (request: Request) => store.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => {
        store.set(request.url, response.clone());
      },
    },
  };
  (globalThis as unknown as { caches: unknown }).caches = fake;
}

afterEach(() => {
  delete (globalThis as unknown as { caches?: unknown }).caches;
  store.clear();
});

describe('adminCache', () => {
  it('serves the second GET from cache and skips the handler', async () => {
    installFakeCaches();
    const app = new Hono<AppEnv>();
    const handler = vi.fn((c) => c.json({ value: 1 }));
    app.use('/stats', adminCache());
    app.get('/stats', handler);

    const first = await app.request('http://local/stats');
    const second = await app.request('http://local/stats');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await first.json()).toEqual({ value: 1 });
    expect(appendHeader(second.headers.get('cache-control'))).toContain('max-age=10');
  });

  it('does not cache non-200 responses', async () => {
    installFakeCaches();
    const app = new Hono<AppEnv>();
    const handler = vi.fn((c) => c.json({ error: true }, 500));
    app.use('/stats', adminCache());
    app.get('/stats', handler);

    await app.request('http://local/stats');
    await app.request('http://local/stats');
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

function appendHeader(value: string | null): string {
  return value ?? '';
}
