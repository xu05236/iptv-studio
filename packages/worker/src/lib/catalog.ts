import type { ChannelIndex, ChannelConfig, LineEntry } from '@iptv/core';
import { bucketOf } from '@iptv/core';
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
  const bucket = await getJson<{ channels: ChannelShard[] }>(env, `state/bucket/${bucketOf(channelId)}.json`);
  if (!bucket) return null;
  return bucket.channels.find((item) => item.channel.id === channelId) ?? null;
}

export async function loadGuide(env: Env): Promise<unknown> {
  return getJson<unknown>(env, 'state/guide.json');
}
