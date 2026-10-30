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
  for (const sub of items) {
    if (!sub.enabled) continue;
    let customKeys: string[] = [];
    try {
      customKeys = JSON.parse(sub.line_keys ?? '[]') as string[];
    } catch {
      customKeys = [];
    }
    if (customKeys.length) {
      logger.info('自定义订阅由 Worker 按 line_keys 动态渲染', { id: sub.id });
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

    // Per-subscription EPG: players should not download the full 6MB guide.
    if (epg && sub.includeEpg) {
      const ids = new Set(selected.map((item) => item.channel.id));
      const channels = epg.channels.filter((channel) => ids.has(channel.id));
      const programmes = epg.programmes.filter((programme) => ids.has(programme.channelId));
      if (channels.length) {
        const xml = buildXmltv(
          { channels, programmes },
          {
            generator: 'iptv-studio',
            channelNames: new Map(channels.map((channel) => [channel.id, channel.names[0] ?? channel.id])),
          },
        );
        if (new TextEncoder().encode(xml).byteLength < 24 * 1024 * 1024) {
          // Keep only the raw XML: the Worker now lets Cloudflare compress it
          // once at the edge, and the pre-gzipped copy caused double gzip.
          await store.put(`out/epg-${sub.id}.xml`, xml, 'application/xml; charset=utf-8');
          written += 1;
        }
      }
    }
  }

  logger.info('订阅产物已生成', { subscriptions: items.length, files: written });
  return written;
}
