import type { ChannelIndex, ChannelConfig, LineEntry, PoolSnapshot } from '@iptv/core';
import { BUCKET_COUNT, bucketOf } from '@iptv/core';
import type { Env } from '../env.js';
import { getJson } from './store.js';

export interface CatalogItem {
  channel: ChannelConfig;
  lines: LineEntry[];
}

export interface ExportCatalog {
  version: 1;
  runId: string;
  generatedAt: string;
  items: CatalogItem[];
}

export interface ChannelShard {
  channel: ChannelConfig;
  lines: LineEntry[];
  epg?: { now?: NowPlaying; next?: NowPlaying[] };
}

export interface NowPlaying {
  title: string;
  start: number;
  stop?: number;
}

/** The pre-rendered export catalog written by the runner. */
export async function loadCatalog(env: Env): Promise<ExportCatalog | null> {
  return getJson<ExportCatalog>(env, 'out/catalog.json');
}

export async function loadIndex(env: Env): Promise<ChannelIndex | null> {
  return getJson<ChannelIndex>(env, 'state/index.json');
}

export async function loadChannelShard(env: Env, channelId: string): Promise<ChannelShard | null> {
  // The runner writes BUCKET_COUNT (8) buckets. Try that first, then the
  // legacy 16/64 layouts so details keep working while a fresh publish rolls
  // out. Only missing channels pay the extra reads.
  const tried = new Set<number>();
  for (const count of [BUCKET_COUNT, 16, 64]) {
    const index = bucketOf(channelId, count);
    if (tried.has(index)) continue;
    tried.add(index);
    const bucket = await getJson<{ channels: ChannelShard[] }>(env, `state/bucket/${index}.json`);
    const found = bucket?.channels.find((item) => item.channel.id === channelId);
    if (found) return found;
  }
  return null;
}

export async function loadGuide(env: Env): Promise<unknown> {
  return getJson<unknown>(env, 'state/guide.json');
}

/** Compact tested-alive lines written by the runner, used by pool subscriptions. */
export async function loadPoolSnapshot(env: Env): Promise<PoolSnapshot | null> {
  return getJson<PoolSnapshot>(env, 'state/pool.json');
}
