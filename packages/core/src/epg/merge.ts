import type { EpgChannel, EpgData, EpgProgramme } from './xmltv.js';
import { ChannelRegistry } from '../normalize/channels.js';

export interface MergeOptions {
  /** keep programmes that started up to this many hours ago (for catch-up display) */
  lookbackHours?: number;
  /** how many days of guide to keep */
  days?: number;
  now?: Date;
  /** only keep these channel ids (subscription filtered guide) */
  channelIds?: Set<string>;
  maxProgrammesPerChannel?: number;
}

/**
 * Map provider channel ids/names onto our canonical channel ids. Providers use
 * `CCTV1`, `cctv-1`, `CCTV-1 综合`, `湖南卫视` … the registry handles all of it.
 */
export function matchEpg(data: EpgData, registry: ChannelRegistry): EpgData {
  const idMap = new Map<string, string>();
  const channels: EpgChannel[] = [];
  const seen = new Set<string>();

  for (const channel of data.channels) {
    const resolved = registry.resolve(channel.names[0] ?? channel.id, { tvgId: channel.id });
    idMap.set(channel.id, resolved.id);
    if (!seen.has(resolved.id)) {
      seen.add(resolved.id);
      channels.push({ id: resolved.id, names: [resolved.name], icon: channel.icon });
    }
  }

  const programmes: EpgProgramme[] = [];
  for (const programme of data.programmes) {
    const channelId = idMap.get(programme.channelId) ?? registry.resolve(programme.channelId, { tvgId: programme.channelId }).id;
    programmes.push({ ...programme, channelId });
  }
  return { channels, programmes };
}

/**
 * Merge multiple XMLTV sources. The common trap: most public guides only cover
 * "today", so a second source with a 7 day window is what makes the weekly view
 * useful. Duplicate (channel, start, title) entries keep the richest metadata.
 */
export function mergeEpg(sources: EpgData[], options: MergeOptions = {}): EpgData {
  const now = (options.now ?? new Date()).getTime();
  const lookback = (options.lookbackHours ?? 12) * 3_600_000;
  const horizon = now + (options.days ?? 7) * 86_400_000;
  const maxPerChannel = options.maxProgrammesPerChannel ?? 500;

  const channels = new Map<string, EpgChannel>();
  const programmes = new Map<string, EpgProgramme>();

  for (const source of sources) {
    for (const channel of source.channels) {
      const existing = channels.get(channel.id);
      if (!existing) channels.set(channel.id, { ...channel, names: [...channel.names] });
      else if (!existing.icon && channel.icon) existing.icon = channel.icon;
    }

    for (const programme of source.programmes) {
      if (programme.start < now - lookback || programme.start > horizon) continue;
      if (options.channelIds && !options.channelIds.has(programme.channelId)) continue;
      // Providers differ by a few seconds on the same programme. Bucket the
      // start time to a minute so a channel does not get overlapping duplicates
      // from multiple XMLTV sources.
      const key = `${programme.channelId}\u0001${Math.floor(programme.start / 60_000)}`;
      const existing = programmes.get(key);
      if (!existing) {
        programmes.set(key, { ...programme, title: programme.title.trim() });
        continue;
      }
      programmes.set(key, {
        ...existing,
        stop: existing.stop ?? programme.stop,
        desc: (existing.desc?.length ?? 0) >= (programme.desc?.length ?? 0) ? existing.desc : programme.desc,
        category: existing.category ?? programme.category,
        icon: existing.icon ?? programme.icon,
      });
    }
  }

  const grouped = new Map<string, EpgProgramme[]>();
  for (const programme of programmes.values()) {
    const list = grouped.get(programme.channelId) ?? [];
    list.push(programme);
    grouped.set(programme.channelId, list);
  }

  const merged: EpgProgramme[] = [];
  for (const list of grouped.values()) {
    list.sort((a, b) => a.start - b.start);
    merged.push(...list.slice(0, maxPerChannel));
  }
  merged.sort((a, b) => a.start - b.start);

  for (const channel of channels.values()) {
    channel.names = [...new Set(channel.names.filter(Boolean))];
  }
  return { channels: [...channels.values()], programmes: merged };
}

function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, '').toLowerCase();
}

/** Programs airing right now, used by the channel detail sheet. */
export function nowPlaying(data: EpgData, channelId: string, at = Date.now()): EpgProgramme | undefined {
  return data.programmes.find(
    (programme) => programme.channelId === channelId && programme.start <= at && (programme.stop ?? programme.start + 3_600_000) > at,
  );
}
