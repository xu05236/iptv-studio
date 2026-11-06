import {
  buildPlaylist,
  buildXmltv,
  selectLines,
  toExportChannels,
  type AppSettings,
  type EpgData,
  type PlaylistFormat,
  type Protocol,
  type Quality,
} from '@iptv/core';
import type { ApiClient, ArtifactStore, ExportCatalog } from '../store.js';
import type { RunLogger } from '../logger.js';

interface SubscriptionRow {
  id: string;
  name: string;
  token: string;
  enabled: boolean;
  groups: string[];
  excludeGroups: string[];
  channelIds: string[];
  line_keys?: string;
  pool_mode?: string;
  proxy_mode?: string;
  min_resolution: string;
  min_speed_kbps: number;
  protocols: string[];
  max_lines_per_channel: number;
  showRegionSuffix: boolean;
  includeEpg: boolean;
  format: string;
  updated_at: string;
}

/**
 * Pre-render every subscription so the Worker can serve a static R2 object.
 * On-demand rendering still exists as a fallback, but this keeps the hot path
 * at zero JSON parsing / zero CPU, which matters on the Workers free plan.
 */
export async function publishSubscriptions(
  api: ApiClient,
  store: ArtifactStore,
  catalog: ExportCatalog,
  settings: AppSettings,
  publicBaseUrl: string,
  epg: EpgData | null,
  logger: RunLogger,
): Promise<number> {
  let { items } = await api.get<{ items: SubscriptionRow[] }>('/api/admin/subscriptions');
  if (!items.length) return 0;

  let written = 0;
  // Many subscriptions share the same channel set; render each distinct set once.
  const epgCache = new Map<string, string>();
  const writePerSubEpg = async (sub: SubscriptionRow, lineKeys: string[] = []): Promise<boolean> => {
    if (!epg || !sub.includeEpg) return false;
    const keySet = new Set(lineKeys);
    const ids = new Set(
      catalog.items
        .filter((item) => {
          if (item.channel.enabled === false) return false;
          if (keySet.size) return item.lines.some((line) => keySet.has(line.key));
          if (sub.channelIds.length && !sub.channelIds.includes(item.channel.id)) return false;
          if (sub.groups.length && !sub.groups.includes(item.channel.group)) return false;
          if (sub.excludeGroups.length && sub.excludeGroups.includes(item.channel.group)) return false;
          return true;
        })
        .map((item) => item.channel.id),
    );
    const channels = epg.channels.filter((channel) => ids.has(channel.id));
    const programmes = epg.programmes.filter((programme) => ids.has(programme.channelId));
    // 4K/8K variants often have no separate XMLTV feed. Reuse the base
    // channel's schedule under the variant id so players still show a guide.
    const epgChannelById = new Map(epg.channels.map((channel) => [channel.id, channel]));
    for (const id of ids) {
      if (epgChannelById.has(id)) continue;
      const baseId = id.replace(/-(?:4k|8k)$/i, '');
      if (baseId === id) continue;
      // Satellite channels often use `hunan-weishi` while their 4K variant is
      // `hunan-4k`; try both the raw base and the -weishi alias.
      const base = epgChannelById.get(baseId) ?? epgChannelById.get(`${baseId}-weishi`);
      if (!base) continue;
      const sourceId = base.id;
      channels.push({ ...base, id });
      programmes.push(...epg.programmes.filter((programme) => programme.channelId === sourceId).map((programme) => ({ ...programme, channelId: id })));
    }
    if (!channels.length) return false;
    // Players only need the future, and long descriptions dominate the size of
    // dozens of nearly identical per-subscription guides. Shrink first, then
    // shrink the window; if it still exceeds the KV value limit, skip the
    // per-sub artifact so the route falls back to the shared out/epg.xml.
    const now = Date.now();
    const fit = (maxDays: number): string | null => {
      const limit = now + maxDays * 86_400_000;
      const trimmed = programmes
        .filter((programme) => (programme.stop ?? programme.start + 3_600_000) >= now && programme.start <= limit)
        .map((programme) => (programme.desc && programme.desc.length > 80 ? { ...programme, desc: `${programme.desc.slice(0, 80)}…` } : programme));
      const body = buildXmltv(
        { channels, programmes: trimmed },
        { generator: 'iptv-studio', channelNames: new Map(channels.map((channel) => [channel.id, channel.names[0] ?? channel.id])) },
      );
      return new TextEncoder().encode(body).byteLength < 24 * 1024 * 1024 ? body : null;
    };
    const cacheKey = [...ids].sort().join(',');
    let xml = epgCache.get(cacheKey) ?? null;
    if (!xml) {
      xml = fit(3) ?? fit(1);
      if (!xml) return false;
      epgCache.set(cacheKey, xml);
    }
    await store.put(`out/epg-${sub.id}.xml`, xml, 'application/xml; charset=utf-8');
    return true;
  };
  for (const sub of items) {
    if (!sub.enabled) continue;
    let customKeys: string[] = [];
    try {
      customKeys = JSON.parse(sub.line_keys ?? '[]') as string[];
    } catch {
      customKeys = [];
    }
    // Always refresh the per-subscription EPG, including pool-driven subs.
    // Otherwise the stale per-sub artifact shadows the new out/epg.xml.
    if (await writePerSubEpg(sub, customKeys)) written++;
    if (customKeys.length) {
      logger.info('自定义订阅由 Worker 按 line_keys 动态渲染', { id: sub.id });
      continue;
    }
    if ((sub.proxy_mode ?? 'direct') !== 'direct') {
      // F2: proxy URLs need an HMAC signed with the Worker's secret at render time.
      logger.info('代理模式订阅由 Worker 动态渲染', { id: sub.id, mode: sub.proxy_mode });
      continue;
    }
    const poolMode = sub.pool_mode ?? 'premium';
    if (poolMode === 'premium' || poolMode === 'premium_backup') {
      logger.info('池驱动订阅由 Worker 按 state/pool.json 动态渲染', { id: sub.id, mode: poolMode });
      continue;
    }
    const selected = catalog.items
      .filter((item) => {
        if (item.channel.enabled === false) return false;
        if (sub.channelIds.length && !sub.channelIds.includes(item.channel.id)) return false;
        if (sub.groups.length && !sub.groups.includes(item.channel.group)) return false;
        if (sub.excludeGroups.length && sub.excludeGroups.includes(item.channel.group)) return false;
        return true;
      })
      .map((item) => ({
        channel: item.channel,
        lines: selectLines(item.lines, {
          maxLines: sub.max_lines_per_channel,
          maxPerSource: sub.max_lines_per_channel > 0 ? 3 : 0,
          minQuality: sub.min_resolution as Quality | 'any',
          minSpeedKbps: sub.min_speed_kbps,
          protocols: sub.protocols.length ? (sub.protocols as Protocol[]) : undefined,
          compensate: true,
          keepSuspect: true,
          relativeFloor: sub.max_lines_per_channel > 0,
        }),
      }))
      .filter((item) => item.lines.length > 0);

    if (!selected.length) continue;
    const epgUrl = sub.includeEpg ? `${publicBaseUrl}/epg/${sub.token}.xml` : null;

    for (const format of ['m3u', 'txt', 'json', 'diyp'] as PlaylistFormat[]) {
      const channels = toExportChannels(selected, {
        logoBaseUrl: settings.logoBaseUrl,
        logoProxyBase: `${publicBaseUrl.replace(/\/+$/, '')}/api/public/logo`,
        showRegionSuffix: sub.showRegionSuffix,
      });
      const body = buildPlaylist(channels, format, {
        epgUrl: epgUrl ?? undefined,
        showRegionSuffix: sub.showRegionSuffix,
        headerComment: `iptv-studio · ${sub.name}`,
      });
      const key = format === 'diyp' ? `out/sub-${sub.id}.diyp` : `out/sub-${sub.id}.${format === 'm3u' ? 'm3u' : format}`;
      await store.put(
        key,
        body,
        format === 'm3u' ? 'audio/x-mpegurl; charset=utf-8' : format === 'txt' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      );
      written++;
    }

    // TVBox live config: one entry pointing at the M3U subscription.
    const tvbox = {
      name: 'IPTV Studio',
      epg: sub.includeEpg ? `${publicBaseUrl}/epg/${sub.token}.xml` : undefined,
      lives: [
        {
          name: sub.name,
          type: 0,
          url: `${publicBaseUrl}/sub/${sub.token}.m3u`,
          playerType: 1,
        },
      ],
    };
    await store.put(`out/sub-${sub.id}.tvbox`, JSON.stringify(tvbox), 'application/json; charset=utf-8');
    written++;
  }

  logger.info('订阅产物已生成', { subscriptions: items.length, files: written });
  return written;
}
