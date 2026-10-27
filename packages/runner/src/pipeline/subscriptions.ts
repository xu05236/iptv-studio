import {
  buildPlaylist,
  selectLines,
  toExportChannels,
  type AppSettings,
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
  logger: RunLogger,
): Promise<number> {
  let { items } = await api.get<{ items: SubscriptionRow[] }>('/api/admin/subscriptions');
  if (!items.length) return 0;

  let written = 0;
  for (const sub of items) {
    if (!sub.enabled) continue;
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
          maxPerSource: 3,
          minQuality: sub.min_resolution as Quality | 'any',
          minSpeedKbps: sub.min_speed_kbps,
          protocols: sub.protocols.length ? (sub.protocols as Protocol[]) : undefined,
          compensate: true,
          keepSuspect: true,
        }),
      }))
      .filter((item) => item.lines.length > 0);

    if (!selected.length) continue;
    const epgUrl = sub.includeEpg ? `${publicBaseUrl}/epg/${sub.token}.xml` : null;

    for (const format of ['m3u', 'txt', 'json', 'diyp'] as PlaylistFormat[]) {
      const channels = toExportChannels(selected, {
        logoBaseUrl: settings.logoBaseUrl,
        showRegionSuffix: sub.showRegionSuffix,
      });
      const body = buildPlaylist(channels, format, {
        epgUrl: epgUrl ?? undefined,
        showRegionSuffix: sub.showRegionSuffix,
        headerComment: `iptv-studio · ${sub.name} · ${catalog.generatedAt}`,
      });
      const key = format === 'diyp' ? `out/sub-${sub.id}.diyp` : `out/sub-${sub.id}.${format === 'm3u' ? 'm3u' : format}`;
      await store.put(
        key,
        body,
        format === 'm3u' ? 'audio/x-mpegurl; charset=utf-8' : format === 'txt' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      );
      written++;
    }
  }

  logger.info('订阅产物已生成', { subscriptions: items.length, files: written });
  return written;
}
