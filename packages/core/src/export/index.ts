import type { ChannelConfig, LineEntry } from '../types.js';
import { channelLogo } from '../normalize/channels.js';
import type { ExportChannel, ExportLine, PlaylistFormat, PlaylistOptions } from './types.js';
import { buildM3U } from './m3u.js';
import { buildDIYP, buildJSON, buildTXT } from './txt.js';

export * from './types.js';
export { buildM3U } from './m3u.js';
export { buildTXT, buildJSON, buildDIYP } from './txt.js';

export interface ToExportOptions {
  logoBaseUrl?: string | null;
  /** Public Worker proxy base, e.g. https://host/api/logo. */
  logoProxyBase?: string | null;
  showRegionSuffix?: boolean;
}

/** Map selected catalog lines into the slim shape the exporters need. */
export function toExportChannels(
  entries: Array<{ channel: ChannelConfig; lines: LineEntry[] }>,
  options: ToExportOptions = {},
): ExportChannel[] {
  return entries.map(({ channel, lines }) => ({
    id: channel.id,
    name: channel.name,
    group: channel.group,
    tvgId: channel.tvgId,
    logo: channelLogo(channel, options.logoBaseUrl, options.logoProxyBase),
    number: channel.number,
    lines: lines.map<ExportLine>((line) => ({
      key: line.key,
      sourceId: line.sourceId,
      favorite: line.favorite,
      url: line.url,
      name: line.name,
      headers: line.headers,
      catchup: line.catchup,
      catchupSource: line.catchupSource,
      catchupDays: line.catchupDays,
      region: line.region,
      operator: line.operator,
      resolution: line.resolution,
      speedKbps: line.speedKbps,
    })),
  }));
}

export function buildPlaylist(channels: ExportChannel[], format: PlaylistFormat, options: PlaylistOptions = {}): string {
  switch (format) {
    case 'txt':
      return buildTXT(channels, options);
    case 'json':
      return buildJSON(channels, options);
    case 'diyp':
      return buildDIYP(channels, options);
    case 'm3u':
    default:
      return buildM3U(channels, options);
  }
}

export function extensionFor(format: PlaylistFormat): string {
  return format === 'txt' ? 'txt' : format === 'm3u' ? 'm3u' : 'json';
}

export function contentTypeFor(format: PlaylistFormat): string {
  switch (format) {
    case 'txt':
      return 'text/plain; charset=utf-8';
    case 'json':
    case 'diyp':
      return 'application/json; charset=utf-8';
    case 'm3u':
    default:
      return 'audio/x-mpegurl; charset=utf-8';
  }
}
