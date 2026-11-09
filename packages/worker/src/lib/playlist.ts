import {
  buildPlaylist,
  canonicalPoolUrl,
  compareLines,
  hashId,
  selectLines,
  toExportChannels,
  type ChannelConfig,
  type LineEntry,
  type PlaylistFormat,
  type PoolSnapshot,
  type Quality,
  type SubscriptionSpec,
} from '@iptv/core';
import type { Env } from '../env.js';
import { listChannels, listCustomPoolMembers, listLineOverrides, listLineTombstones, type LineOverrideRow, type SubscriptionRow } from '../db.js';
import { getJson } from './store.js';
import { parseJsonField } from './http.js';
import { loadCatalog, loadPoolSnapshot, type ExportCatalog } from './catalog.js';
import { applyProxyMode } from './proxyRewrite.js';
import { relayQuotaExceeded } from './relayQuota.js';
import { signProxyUrl } from './relaySign.js';

export interface SubscriptionConfig extends SubscriptionSpec {
  updatedAt?: string;
  lineKeys?: string[];
  /** Built-in pool names and/or custom pool ids, when poolMode is "pools". */
  poolIds?: string[];
  poolMode?: string;
  /** Pools mode only: inherit = saved filters, none = full export, custom = saved filters too. */
  filterMode?: string;
  proxyMode?: 'direct' | 'playlist' | 'full';
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
    poolIds: parseJsonField<string[]>(row.pool_ids ?? '[]', []),
    poolMode: row.pool_mode ?? 'premium',
    filterMode: row.filter_mode ?? 'inherit',
    proxyMode: row.proxy_mode === 'playlist' || row.proxy_mode === 'full' ? row.proxy_mode : 'direct',
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
  options: { logoBaseUrl?: string | null; logoProxyBase?: string | null; epgUrl?: string | null },
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
    logoProxyBase: options.logoProxyBase,
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
    JSON.stringify([catalog.runId, config.updatedAt, config.groups, config.excludeGroups, config.channelIds, config.lineKeys, config.minResolution, config.minSpeedKbps, config.protocols, config.maxLinesPerChannel, config.showRegionSuffix, config.format, config.proxyMode]),
    16,
  );
  return `W/"${catalog.runId}-${fingerprint}"`;
}

/**
 * Render a pool-driven subscription from the compact pool snapshot.
 * Manual pool moves (line_overrides) win over the automatic classification, so
 * moving a line to backup/rejected takes effect on the next request without
 * waiting for a collect.
 */
export function buildFromPool(
  snapshot: PoolSnapshot,
  overrides: LineOverrideRow[],
  config: SubscriptionConfig,
  options: { logoBaseUrl?: string | null; logoProxyBase?: string | null; epgUrl?: string | null } = {},
  tombstoned: Set<string> = new Set(),
): { body: string; channels: number; lines: number } {
  const overrideMap = new Map(overrides.map((row) => [row.line_key, row.pool]));
  const rows: Array<{ channel: ChannelConfig; lines: LineEntry[] }> = [];

  for (const entry of Object.values(snapshot.channels)) {
    const channel: ChannelConfig = {
      id: entry.channel.id,
      name: entry.channel.name,
      group: entry.channel.group,
      tvgId: entry.channel.tvgId ?? undefined,
      logo: entry.channel.logo ?? undefined,
      aliases: [],
    };
    if (!channelMatches(channel, config)) continue;

    const premium: LineEntry[] = [];
    const backup: LineEntry[] = [];
    const candidate: LineEntry[] = [];
    const add = (line: LineEntry, autoPool: 'premium' | 'backup' | 'candidate'): void => {
      if (tombstoned.has(canonicalPoolUrl(line.url))) return;
      const pool = overrideMap.get(line.key) ?? autoPool;
      if (pool === 'premium') premium.push(line);
      else if (pool === 'backup') backup.push(line);
      else if (pool === 'candidate') candidate.push(line);
    };
    for (const line of entry.premium) add(line, 'premium');
    for (const line of entry.backup) add(line, 'backup');
    for (const line of entry.candidate) add(line, 'candidate');

    const candidates = config.poolMode === 'all'
      ? [...premium, ...backup, ...candidate]
      : config.poolMode === 'premium_backup' ? [...premium, ...backup] : premium;
    if (!candidates.length) continue;
    candidates.sort(compareLines);
    const unlimited = config.maxLinesPerChannel <= 0;
    const lines = selectLines(candidates, {
      maxLines: config.maxLinesPerChannel,
      maxPerSource: unlimited ? 0 : 3,
      minQuality: config.minResolution,
      minSpeedKbps: config.minSpeedKbps,
      protocols: config.protocols.length ? config.protocols : undefined,
      compensate: false,
      keepSuspect: false,
      relativeFloor: !unlimited,
    });
    if (!lines.length) continue;
    rows.push({ channel, lines });
  }

  const exportChannels = toExportChannels(rows, {
    logoBaseUrl: options.logoBaseUrl ?? null,
    logoProxyBase: options.logoProxyBase,
    showRegionSuffix: config.showRegionSuffix,
  });
  const body = buildPlaylist(exportChannels, config.format, {
    epgUrl: options.epgUrl ?? undefined,
    showRegionSuffix: config.showRegionSuffix,
    headerComment: `iptv-studio · ${config.name}`,
  });
  return { body, channels: exportChannels.length, lines: exportChannels.reduce((sum, channel) => sum + channel.lines.length, 0) };
}

/**
 * Render a subscription that composes pools. The selection may mix built-in
 * buckets (premium/backup/candidate, override-aware) with custom pool ids; a
 * custom pool line is exported even when its automatic bucket says otherwise,
 * because the user explicitly put it there. filterMode "none" exports every
 * selected line, all other modes apply the subscription's saved filters.
 */
export function buildFromPools(
  snapshot: PoolSnapshot,
  overrides: LineOverrideRow[],
  config: SubscriptionConfig,
  customMembers: Map<string, Set<string>>,
  options: { logoBaseUrl?: string | null; logoProxyBase?: string | null; epgUrl?: string | null } = {},
  tombstoned: Set<string> = new Set(),
): { body: string; channels: number; lines: number } {
  const selected = new Set(config.poolIds ?? []);
  const applyFilters = config.filterMode !== 'none';
  const overrideMap = new Map(overrides.map((row) => [row.line_key, row.pool]));
  const builtin = new Set(['premium', 'backup', 'candidate'].filter((name) => selected.has(name)));
  const customKeys = new Set<string>();
  for (const [poolId, members] of customMembers) {
    if (!selected.has(poolId)) continue;
    for (const key of members) customKeys.add(key);
  }

  const rows: Array<{ channel: ChannelConfig; lines: LineEntry[] }> = [];
  for (const entry of Object.values(snapshot.channels)) {
    const channel: ChannelConfig = {
      id: entry.channel.id,
      name: entry.channel.name,
      group: entry.channel.group,
      tvgId: entry.channel.tvgId ?? undefined,
      logo: entry.channel.logo ?? undefined,
      aliases: [],
    };
    if (applyFilters && !channelMatches(channel, config)) continue;

    const collected: LineEntry[] = [];
    const buckets: Array<['premium' | 'backup' | 'candidate', LineEntry[]]> = [
      ['premium', entry.premium],
      ['backup', entry.backup],
      ['candidate', entry.candidate],
    ];
    for (const [bucket, list] of buckets) {
      for (const line of list) {
        if (tombstoned.has(canonicalPoolUrl(line.url))) continue;
        const pool = overrideMap.get(line.key) ?? bucket;
        if (builtin.has(pool) || customKeys.has(line.key)) collected.push(line);
      }
    }
    if (!collected.length) continue;
    const unique = [...new Map(collected.map((line) => [line.key, line])).values()].sort(compareLines);
    const lines = applyFilters
      ? selectLines(unique, {
          maxLines: config.maxLinesPerChannel,
          maxPerSource: config.maxLinesPerChannel <= 0 ? 0 : 3,
          minQuality: config.minResolution,
          minSpeedKbps: config.minSpeedKbps,
          protocols: config.protocols.length ? config.protocols : undefined,
          compensate: false,
          keepSuspect: false,
        })
      : unique;
    if (!lines.length) continue;
    rows.push({ channel, lines });
  }

  const exportChannels = toExportChannels(rows, {
    logoBaseUrl: options.logoBaseUrl ?? null,
    logoProxyBase: options.logoProxyBase,
    showRegionSuffix: config.showRegionSuffix,
  });
  const body = buildPlaylist(exportChannels, config.format, {
    epgUrl: options.epgUrl ?? undefined,
    showRegionSuffix: config.showRegionSuffix,
    headerComment: `iptv-studio · ${config.name}`,
  });
  return { body, channels: exportChannels.length, lines: exportChannels.reduce((sum, channel) => sum + channel.lines.length, 0) };
}

/** Pool renders change whenever the snapshot, an override or a tombstone changes. */
export function poolEtag(
  snapshot: PoolSnapshot,
  overrides: LineOverrideRow[],
  config: SubscriptionConfig,
  tombstones: Array<{ created_at: string }> = [],
  customVersion = '',
): string {
  const overrideVersion = overrides.reduce((max, row) => (row.updated_at > max ? row.updated_at : max), '');
  const tombstoneVersion = tombstones.reduce((max, row) => (row.created_at > max ? row.created_at : max), '');
  const fingerprint = hashId(
    `${snapshot.generatedAt}:${overrideVersion}:${tombstones.length}:${tombstoneVersion}:${config.updatedAt ?? ''}:${config.poolMode}:${(config.poolIds ?? []).join(',')}:${customVersion}:${config.proxyMode ?? 'direct'}`,
    16,
  );
  return `W/"pool-${fingerprint}"`;
}

export async function renderSubscription(
  env: Env,
  config: SubscriptionConfig,
  baseUrl: string,
): Promise<{ body: string; etag: string; channels: number; lines: number } | null> {
  const epgUrl = config.includeEpg ? `${baseUrl}/epg/${config.token}.xml` : null;
  const logoProxyBase = `${baseUrl.replace(/\/+$/, '')}/api/public/logo`;
  // F2: direct mode keeps raw URLs; playlist/full replace playable URLs with signed relay links.
  const finalize = async (result: { body: string; etag: string; channels: number; lines: number }) => {
    const mode = config.proxyMode ?? 'direct';
    if (mode === 'direct') return result;
    // 该 token 当日中继配额已用尽时回退直连，避免整份清单都是 429 地址。
    if (relayQuotaExceeded(`token:${config.token}`)) return result;
    const body = await applyProxyMode(result.body, config.format, (url) => signProxyUrl(env, baseUrl, url, config.token, mode));
    return { ...result, body };
  };
  if (config.poolMode === 'pools' && config.poolIds?.length) {
    const snapshot = await loadPoolSnapshot(env);
    if (snapshot) {
      const customIds = config.poolIds.filter((id) => id.startsWith('pool-'));
      const [overrides, tombstones, members] = await Promise.all([
        listLineOverrides(env),
        listLineTombstones(env),
        listCustomPoolMembers(env, customIds),
      ]);
      const rendered = buildFromPools(snapshot, overrides, config, members, { epgUrl, logoProxyBase }, new Set(tombstones.map((row) => row.url)));
      const customVersion = customIds
        .map((id) => `${id}:${[...(members.get(id) ?? [])].sort().join(',')}`)
        .join('|');
      return finalize({ ...rendered, etag: poolEtag(snapshot, overrides, config, tombstones, customVersion) });
    }
  }

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
    const exportChannels = toExportChannels(rows, { showRegionSuffix: config.showRegionSuffix, logoProxyBase });
    const body = buildPlaylist(exportChannels, config.format, {
      epgUrl: epgUrl ?? undefined,
      showRegionSuffix: config.showRegionSuffix,
      headerComment: `iptv-studio · ${config.name}`,
    });
    return finalize({
      body,
      etag: `W/"custom-${hashId(`${config.updatedAt ?? ''}:${[...keys].join(',')}`, 16)}"`,
      channels: exportChannels.length,
      lines: exportChannels.reduce((sum, channel) => sum + channel.lines.length, 0),
    });
  }

  // Pool-driven subscriptions render from the tested-alive snapshot; the
  // catalog remains the fallback until the first publish writes pool.json.
  const poolMode = config.poolMode ?? 'premium';
  if (poolMode === 'premium' || poolMode === 'premium_backup') {
    const snapshot = await loadPoolSnapshot(env);
    if (snapshot) {
      const [overrides, tombstones] = await Promise.all([listLineOverrides(env), listLineTombstones(env)]);
      const rendered = buildFromPool(snapshot, overrides, config, { epgUrl, logoProxyBase }, new Set(tombstones.map((row) => row.url)));
      return finalize({ ...rendered, etag: poolEtag(snapshot, overrides, config, tombstones) });
    }
  }

  const catalog = await loadCatalog(env);
  if (!catalog) return null;
  const rendered = buildFromCatalog(catalog, config, { logoBaseUrl: undefined, epgUrl, logoProxyBase });
  return finalize({ ...rendered, etag: playlistEtag(catalog, config) });
}
