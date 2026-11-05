import type { RequestHeaders } from '../types.js';

export interface ExportLine {
  key?: string;
  sourceId?: string;
  sourceName?: string;
  pool?: 'premium' | 'backup' | 'candidate' | 'pending' | 'quarantine' | 'rejected';
  favorite?: boolean;
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

function shortResolution(value?: string): string {
  if (!value) return '';
  const dimensions = /^\d{3,4}x(\d{3,4})$/i.exec(value);
  if (dimensions) return `${dimensions[1]}P`;
  return /^\d{3,4}[pi]$/i.test(value) ? value.toUpperCase() : value;
}

export function lineDisplayName(channel: ExportChannel, line: ExportLine, options: PlaylistOptions): string {
  const base = channel.name || line.name || channel.id;
  let name = base;
  // Never add region/line details here: players group streams by display name,
  // and any per-line suffix turns one channel into many duplicate entries.
  if (options.debugNames) {
    const speed = line.speedKbps ? `${Math.round(line.speedKbps / 1000)}M` : '';
    const pool = line.pool === 'premium' ? '精品' : line.pool === 'backup' ? '备用' : line.pool === 'candidate' ? '候选' : '';
    const bits = [line.sourceName, pool, shortResolution(line.resolution), speed].filter(Boolean);
    if (bits.length) name += ` · ${bits.join(' · ')}`;
  }
  return name;
}

export function escapeAttr(value: string): string {
  return String(value ?? '').replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
}
