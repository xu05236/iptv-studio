import type { EpgChannel, EpgProgramme } from './xmltv.js';

interface CctvProgrammeRaw {
  t?: string;
  st?: number | string;
  et?: number | string;
  showTime?: string;
  eventType?: string;
  eventId?: string;
}

interface CctvChannelPayload {
  channelName?: string;
  program?: CctvProgrammeRaw[] | CctvProgrammeRaw;
  liveSt?: number;
}

export type CctvEpgPayload = Record<string, CctvChannelPayload>;

/** `今日说法-2026-193` -> `今日说法` (drops the episode suffix). */
export function cleanCctvTitle(raw: string): string {
  return raw
    .replace(/[-－]\s*20\d{2}\s*[-－]\s*\d{1,3}\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toEpochMs(value: number | string | undefined): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed > 1e12 ? parsed : parsed * 1000;
}

/**
 * Parse CNTV's unofficial `api.cntv.cn/epg/epginfo` payload into our canonical
 * EPG shape. Covers CCTV channels only; everything else still comes from XMLTV.
 */
export function parseCctvEpg(payload: CctvEpgPayload, channelId: string): { channel: EpgChannel; programmes: EpgProgramme[] } | null {
  const entry = payload[channelId] ?? Object.values(payload)[0];
  if (!entry) return null;

  const raw = entry.program === undefined ? [] : Array.isArray(entry.program) ? entry.program : [entry.program];
  const programmes: EpgProgramme[] = [];
  const seen = new Set<number>();

  for (const item of raw) {
    const start = toEpochMs(item.st);
    if (start === null || seen.has(start)) continue;
    const title = cleanCctvTitle(String(item.t ?? ''));
    if (!title) continue;
    seen.add(start);
    const stop = toEpochMs(item.et);
    programmes.push({
      channelId,
      start,
      stop: stop ?? start + 30 * 60_000,
      title,
      category: item.eventType || undefined,
    });
  }

  if (!programmes.length) return null;
  programmes.sort((a, b) => a.start - b.start);

  const name = entry.channelName?.trim() || channelId;
  return { channel: { id: channelId, names: [name] }, programmes };
}

/** CNTV channel code for our canonical id, or null when unsupported. */
export function cctvApiCode(channelId: string): string | null {
  if (/^cctv(?:[1-9]|1[0-7])(?:plus)?$/.test(channelId)) return channelId;
  if (/^cctv(?:4k|8k)$/.test(channelId)) return channelId;
  return null;
}
