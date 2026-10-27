import type { RequestHeaders } from '../types.js';

export interface ExportLine {
  url: string;
  name?: string;
  headers?: RequestHeaders;
  catchup?: string;
  catchupSource?: string;
  catchupDays?: number;
  region?: string;
  operator?: string;
  resolution?: string;
  speedKbps?: number;
}

export interface ExportChannel {
  id: string;
  name: string;
  group: string;
  tvgId?: string;
  logo?: string;
  number?: number;
  lines: ExportLine[];
}

export interface PlaylistOptions {
  epgUrl?: string;
  showRegionSuffix?: boolean;
  /** append resolution/speed markers to the line name (debug friendly) */
  debugNames?: boolean;
  m3uPlus?: boolean;
  catchupDefault?: string;
  headerComment?: string;
}

export type PlaylistFormat = 'm3u' | 'txt' | 'json' | 'diyp';

export function regionTag(line: Pick<ExportLine, 'region' | 'operator'>): string {
  const parts = [line.region, line.operator].filter(Boolean) as string[];
  return parts.length ? `（-${parts.join('')}）` : '';
}

export function lineDisplayName(channel: ExportChannel, line: ExportLine, options: PlaylistOptions): string {
  const base = channel.name || line.name || channel.id;
  let name = base;
  if (options.showRegionSuffix !== false) name += regionTag(line);
  if (options.debugNames) {
    const bits = [line.resolution, line.speedKbps ? `${Math.round(line.speedKbps)}kbps` : ''].filter(Boolean);
    if (bits.length) name += ` [${bits.join(' ')}]`;
  }
  return name;
}

export function escapeAttr(value: string): string {
  return String(value ?? '').replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
}
