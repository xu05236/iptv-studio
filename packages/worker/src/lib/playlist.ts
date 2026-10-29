import {
  buildPlaylist,
  hashId,
  selectLines,
  toExportChannels,
  type ChannelConfig,
  type LineEntry,
  type PlaylistFormat,
  type Quality,
  type SubscriptionSpec,
} from '@iptv/core';
import type { Env } from '../env.js';
import { listChannels, type SubscriptionRow } from '../db.js';
import { getJson } from './store.js';
import { parseJsonField } from './http.js';
import { loadCatalog, type ExportCatalog } from './catalog.js';

export interface SubscriptionConfig extends SubscriptionSpec {
  updatedAt?: string;
  lineKeys?: string[];
  poolMode?: string;
}

export function subscriptionFromRow(row: SubscriptionRow): SubscriptionConfig {
  return {
    id: row.id,
    name: row.name,
    token: row.token,
    enabled: row.enabled === 1,
    groups: parseJsonField<string[]>(row.groups, []),
    excludeGroups: parseJsonField<string[]>(row.exclude_groups, []),
    channelIds: parseJsonField<string[]>(row.channel_ids, []),
    lineKeys: parseJsonField<string[]>(row.line_keys ?? '[]', []),
    poolMode: row.pool_mode ?? 'premium',
    minResolution: row.min_resolution as Quality | 'any',
    minSpeedKbps: row.min_speed_kbps,
    protocols: parseJsonField(row.protocols, []),
    maxLinesPerChannel: row.max_lines_per_channel,
    showRegionSuffix: row.show_region_suffix === 1,
    includeEpg: row.include_epg === 1,
    format: row.format as PlaylistFormat,
    updatedAt: row.updated_at,
  };
}

export function channelMatches(channel: ChannelConfig, config: SubscriptionConfig): boolean {
  if (config.channelIds.length && !config.channelIds.includes(channel.id)) return false;
  if (config.groups.length && !config.groups.includes(channel.group)) return false;
  if (config.excludeGroups.length && config.excludeGroups.includes(channel.group)) return false;
  return true;
}

export function buildFromCatalog(
  catalog: ExportCatalog,
  config: SubscriptionConfig,
  options: { logoBaseUrl?: string | null; epgUrl?: string | null },
): { body: string; channels: number; lines: number } {
  const rows: Array<{ channel: ChannelConfig; lines: LineEntry[] }> = [];
  const allowedKeys = new Set(config.lineKeys ?? []);
  for (const item of catalog.items) {
    if (item.channel.enabled === false) continue;
    if (!channelMatches(item.channel, config)) continue;
    const candidates = allowedKeys.size ? item.lines.filter((line) => allowedKeys.has(line.key)) : item.lines;
    if (!candidates.length) continue;
    const lines = selectLines(candidates, {
      maxLines: config.maxLinesPerChannel,
      maxPerSource: 3,
      minQuality: config.minResolution,
      minSpeedKbps: config.minSpeedKbps,
      protocols: config.protocols.length ? config.protocols : undefined,
      compensate: true,
      keepSuspect: true,
    });
    if (!lines.length) continue;
    rows.push({ channel: item.channel, lines });
  }

  const exportChannels = toExportChannels(rows, {
    logoBaseUrl: options.logoBaseUrl,
    showRegionSuffix: config.showRegionSuffix,
  });

  const body = buildPlaylist(exportChannels, config.format, {
    epgUrl: options.epgUrl ?? undefined,
    showRegionSuffix: config.showRegionSuffix,
    headerComment: `iptv-studio · ${config.name} · ${catalog.generatedAt}`,
  });

  return { body, channels: exportChannels.length, lines: exportChannels.reduce((sum, channel) => sum + channel.lines.length, 0) };
}

/** Strong ETag derived from catalog version + subscription configuration. */
export function playlistEtag(catalog: ExportCatalog, config: SubscriptionConfig): string {
  const fingerprint = hashId(
    JSON.stringify([catalog.runId, config.updatedAt, config.groups, config.excludeGroups, config.channelIds, config.lineKeys, config.minResolution, config.minSpeedKbps, config.protocols, config.maxLinesPerChannel, config.showRegionSuffix, config.format]),
    16,
  );
  return `W/"${catalog.runId}-${fingerprint}"`;
}

export async function renderSubscription(
  env: Env,
  config: SubscriptionConfig,
  baseUrl: string,
): Promise<{ body: string; etag: string; channels: number; lines: number } | null> {
  const epgUrl = config.includeEpg ? `${baseUrl}/epg/${config.token}.xml` : null;
  if (config.lineKeys?.length) {
    const [state, channels] = await Promise.all([
      getJson<{ lines: LineEntry[] }>(env, 'state/lines.json'),
      listChannels(env),
    ]);
    const keys = new Set(config.lineKeys);
    const channelMap = new Map(channels.map((channel) => [channel.id, channel]));
    const grouped = new Map<string, LineEntry[]>();
    for (const line of state?.lines ?? []) {
      if (!keys.has(line.key)) continue;
      const list = grouped.get(line.channelId) ?? [];
      list.push(line);
      grouped.set(line.channelId, list);
    }
    const rows: Array<{ channel: ChannelConfig; lines: LineEntry[] }> = [];
    for (const [channelId, lines] of grouped) {
      const channel = channelMap.get(channelId);
      rows.push({
        channel: {
          id: channelId,
          name: channel?.name ?? channelId,
          group: channel?.group_title ?? '其他',
          tvgId: channel?.tvg_id ?? undefined,
          logo: channel?.logo ?? undefined,
        },
        lines,
      });
    }
    if (!rows.length) return null;
    const exportChannels = toExportChannels(rows, { showRegionSuffix: config.showRegionSuffix });
    const body = buildPlaylist(exportChannels, config.format, {
      epgUrl: epgUrl ?? undefined,
      showRegionSuffix: config.showRegionSuffix,
      headerComment: `iptv-studio · ${config.name}`,
    });
    return {
      body,
      etag: `W/"custom-${hashId(`${config.updatedAt ?? ''}:${[...keys].join(',')}`, 16)}"`,
      channels: exportChannels.length,
      lines: exportChannels.reduce((sum, channel) => sum + channel.lines.length, 0),
    };
  }
  const catalog = await loadCatalog(env);
  if (!catalog) return null;
  const rendered = buildFromCatalog(catalog, config, { logoBaseUrl: undefined, epgUrl });
  return { ...rendered, etag: playlistEtag(catalog, config) };
}
