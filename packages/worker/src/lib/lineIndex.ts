import type { RequestHeaders } from '@iptv/core';
import type { Env } from '../env.js';
import { getJson } from './store.js';

export interface LineIndexItem {
  key: string;
  url: string;
  headers?: RequestHeaders;
}

interface LineIndexPayload {
  generatedAt?: string;
  items: LineIndexItem[];
}

const TTL_MS = 60_000;
const CACHE_URL = 'https://iptv-studio.internal/state/line-index.json';

let memory: { at: number; map: Map<string, LineIndexItem>; byUrl: Map<string, RequestHeaders | undefined> } | null = null;

function cacheStorage(): Cache | null {
  try {
    return caches.default ?? null;
  } catch {
    return null;
  }
}

/**
 * F6: 中继热路径的线路索引。优先 isolate 内存（60s），其次 Cache API，
 * 最后才回源 KV 的 state/line-index.json；避免每次分片请求解析整份 probe.json。
 */
export async function loadLineIndex(env: Env): Promise<Map<string, LineIndexItem>> {
  if (memory && Date.now() - memory.at < TTL_MS) return memory.map;

  let payload: LineIndexPayload | null = null;
  const cache = cacheStorage();
  if (cache) {
    try {
      const hit = await cache.match(CACHE_URL);
      if (hit) payload = (await hit.json()) as LineIndexPayload;
    } catch {
      payload = null;
    }
  }

  if (!payload) {
    payload = await getJson<LineIndexPayload>(env, 'state/line-index.json');
    if (!payload) {
      // 过渡期兼容：新索引还没随发布产出前，从 probe.json 现建一次（只在本 isolate 首次发生）。
      const probe = await getJson<{ generatedAt?: string; items: LineIndexItem[] }>(env, 'state/probe.json');
      if (probe?.items?.length) payload = { generatedAt: probe.generatedAt, items: probe.items };
    }
    if (payload && cache) {
      try {
        await cache.put(
          CACHE_URL,
          new Response(JSON.stringify(payload), {
            headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'max-age=60' },
          }),
        );
      } catch {
        // Cache API 失败不影响请求。
      }
    }
  }

  const map = new Map((payload?.items ?? []).map((item) => [item.key, item]));
  const byUrl = new Map((payload?.items ?? []).map((item) => [item.url, item.headers]));
  memory = { at: Date.now(), map, byUrl };
  return map;
}

/** F2: look up upstream headers for a proxied URL (same cached index, by URL). */
export async function lineHeadersForUrl(env: Env, url: string): Promise<RequestHeaders | undefined> {
  await loadLineIndex(env);
  return memory?.byUrl.get(url);
}
