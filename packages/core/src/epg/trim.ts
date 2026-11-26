import type { EpgData, EpgProgramme } from './xmltv.js';

export interface TrimEpgOptions {
  /** keep programmes starting within [now - lookback, now + hours) */
  hours?: number;
  lookbackHours?: number;
  /** cap programmes per channel, earliest first */
  maxProgrammesPerChannel?: number;
  /** epoch ms, defaults to Date.now() */
  now?: number;
}

/**
 * Keep the guide small enough for the shared `out/epg.xml` artifact. Per
 * subscription guides are generated from the untrimmed data, so this only
 * affects the global fallback file.
 */
export function trimEpgData(data: EpgData, options: TrimEpgOptions = {}): EpgData {
  const now = options.now ?? Date.now();
  const hours = Math.max(1, options.hours ?? 12);
  const lookback = Math.max(0, options.lookbackHours ?? 1);
  const limit = Math.max(1, options.maxProgrammesPerChannel ?? 48);
  const from = now - lookback * 3_600_000;
  const to = now + hours * 3_600_000;

  const counts = new Map<string, number>();
  const programmes: EpgProgramme[] = [];
  for (const programme of [...data.programmes].sort((left, right) => left.start - right.start)) {
    if (programme.start < from || programme.start >= to) continue;
    const used = counts.get(programme.channelId) ?? 0;
    if (used >= limit) continue;
    counts.set(programme.channelId, used + 1);
    programmes.push(programme);
  }

  const kept = new Set(programmes.map((programme) => programme.channelId));
  return {
    channels: data.channels.filter((channel) => kept.has(channel.id)),
    programmes,
  };
}
