import type { Env } from '../env.js';
import { listChannels, type ChannelRow } from '../db.js';
import { getJson, putArtifact } from './store.js';

/**
 * Channel metadata is read by many admin pages (stats, sources, pool). Reading
 * the whole `channels` table every time burns D1 rows, so a compact snapshot is
 * written whenever the published channel list changes and read from KV instead.
 */
export const CHANNEL_META_KEY = 'state/channel-meta.json';

interface ChannelMetaSnapshot {
  generatedAt: string;
  channels: ChannelRow[];
}

export async function saveChannelMeta(env: Env, channels: ChannelRow[]): Promise<void> {
  const snapshot: ChannelMetaSnapshot = {
    generatedAt: new Date().toISOString(),
    channels: channels.map(({ id, name, tvg_id, group_title, logo, number, enabled, sort, aliases, epg_source, updated_at }) => ({
      id,
      name,
      tvg_id,
      group_title,
      logo,
      number,
      enabled,
      sort,
      aliases,
      epg_source,
      updated_at,
    })),
  };
  await putArtifact(env, CHANNEL_META_KEY, JSON.stringify(snapshot), 'application/json; charset=utf-8');
}

/** Snapshot first, live table only when the snapshot is missing (old deploys). */
export async function loadChannelMeta(env: Env): Promise<ChannelRow[]> {
  const snapshot = await getJson<ChannelMetaSnapshot>(env, CHANNEL_META_KEY);
  if (snapshot?.channels?.length) return snapshot.channels;
  return listChannels(env);
}
