import type { Env } from '../env.js';
import { deleteArtifact, deletePrefix, getJson, putArtifact } from './store.js';

export interface SnapshotItem {
  id: string;
  generatedAt: string;
  channels: number;
  lines: number;
  alive: number;
  createdAt: string;
}

/** Create a rollback snapshot of the currently published artifacts. */
export async function createSnapshot(env: Env, actor: string): Promise<SnapshotItem | null> {
  const [index, catalog, pool, guide] = await Promise.all([
    getJson<Record<string, unknown>>(env, 'state/index.json'),
    getJson<Record<string, unknown>>(env, 'out/catalog.json'),
    getJson<Record<string, unknown>>(env, 'state/pool.json'),
    getJson<Record<string, unknown>>(env, 'state/guide.json'),
  ]);
  if (!index || !catalog) return null;
  const id = `manual-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`;
  const base = `state/snapshots/${id}`;
  const json = 'application/json; charset=utf-8';
  await putArtifact(env, `${base}/index.json`, JSON.stringify(index), json);
  await putArtifact(env, `${base}/catalog.json`, JSON.stringify(catalog), json);
  if (pool) await putArtifact(env, `${base}/pool.json`, JSON.stringify(pool), json);
  if (guide) await putArtifact(env, `${base}/guide.json`, JSON.stringify(guide), json);
  const manifest = await getJson<{ items: SnapshotItem[] }>(env, 'state/snapshots.json');
  const items = (manifest?.items ?? []).filter((item) => item.id !== id);
  const item: SnapshotItem = {
    id,
    generatedAt: new Date().toISOString(),
    channels: Number(index['totalChannels'] ?? 0),
    lines: Number(index['totalLines'] ?? 0),
    alive: Number(index['aliveLines'] ?? 0),
    createdAt: new Date().toISOString(),
  };
  items.unshift(item);
  await putArtifact(env, 'state/snapshots.json', JSON.stringify({ items: items.slice(0, 10) }), json);
  return item;
}

/** Delete every rollback snapshot and its manifest. */
export async function clearSnapshots(env: Env): Promise<number> {
  const manifest = await getJson<{ items: SnapshotItem[] }>(env, 'state/snapshots.json');
  let removed = 0;
  for (const item of manifest?.items ?? []) {
    await deletePrefix(env, `state/snapshots/${item.id}/`);
    removed++;
  }
  await deleteArtifact(env, 'state/snapshots.json');
  return removed;
}
