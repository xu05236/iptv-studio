import type { Env } from '../env.js';
import { getJson } from './store.js';

let ready: Promise<void> | null = null;

function ensure(env: Env): Promise<void> {
  if (!ready) {
    ready = env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS runtime_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
    ).run().then(() => undefined).catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}

/** Small runtime markers live in D1; large artifacts stay in KV. */
export async function getRuntimeJson<T>(env: Env, key: string): Promise<T | null> {
  await ensure(env);
  const row = await env.DB.prepare('SELECT value FROM runtime_state WHERE key = ?').bind(key).first<{ value: string }>();
  if (row?.value) {
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }
  const legacy = await getJson<T>(env, key);
  if (legacy) await putRuntimeJson(env, key, legacy);
  return legacy;
}

export async function putRuntimeJson(env: Env, key: string, value: unknown): Promise<void> {
  await ensure(env);
  await env.DB.prepare(
    "INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
  ).bind(key, JSON.stringify(value)).run();
}
