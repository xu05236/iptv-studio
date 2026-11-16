import type { Context, Next } from 'hono';
import type { AppEnv } from '../env.js';

const DEFAULT_TTL_SECONDS = 10;

/**
 * Short-lived edge cache for read-only admin endpoints that the dashboard polls
 * on every open. Auth middleware runs before route handlers, so a cache hit is
 * only reachable with a valid token. The URL is the cache key; this deployment
 * has a single admin actor, and responses carry no per-user data.
 */
export function adminCache(ttlSeconds = DEFAULT_TTL_SECONDS) {
  return async (c: Context<AppEnv>, next: Next): Promise<void> => {
    if (c.req.method !== 'GET') return next();
    const storage = typeof caches === 'undefined' ? undefined : caches;
    if (!storage?.default) return next();

    const key = new Request(c.req.url, { method: 'GET' });
    try {
      const hit = await storage.default.match(key);
      if (hit) {
        c.res = hit;
        return;
      }
    } catch {
      // A cache lookup failure must never break the endpoint.
    }

    await next();
    if (c.res.status !== 200) return;

    try {
      const cached = c.res.clone();
      cached.headers.set('Cache-Control', `public, max-age=${ttlSeconds}`);
      const put = storage.default.put(key, cached);
      try {
        c.executionCtx.waitUntil(put);
      } catch {
        await put;
      }
    } catch {
      // Ignore cache write failures.
    }
  };
}
