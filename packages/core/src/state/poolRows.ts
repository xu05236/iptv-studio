import { compareLines } from '../aggregate/rank.js';
import { dedupePoolLines, qualityConfirmed } from '../linePool.js';
import type { LineEntry } from '../types.js';

/** Pool buckets used by the admin line pool. */
export type PoolRowPool = 'premium' | 'backup' | 'candidate' | 'pending' | 'quarantine' | 'rejected';

export type PoolRowStatus = 'alive' | 'suspect' | 'dead' | 'unknown';

/**
 * Compact row payload. Channels and sources are stored once, and each line is
 * an array, so the artifact stays small enough to download on a slow link.
 * URLs are deliberately omitted: they are unique, incompressible, and the pool
 * page never displays them (search is by channel / source / line name).
 *
 * lines: [key, channelIndex, sourceIndex, name, resolution, height,
 *         speedKbps, cnCheckedAt, cnLatencyMs, status, passCount,
 *         lastProbeAt, autoPool, transport]
 */
export type SlimPoolLine = [
  string,
  number,
  number,
  string,
  string,
  number,
  number,
  string,
  number,
  PoolRowStatus,
  number,
  string,
  PoolRowPool,
  'direct' | 'relay',
];

export interface PoolRowsSnapshot {
  version: 2;
  generatedAt: string;
  premiumTarget: number;
  /** [id, name, group, country] */
  channels: Array<[string, string, string, string]>;
  /** [id, name, reputation] */
  sources: Array<[string, string, number]>;
  lines: SlimPoolLine[];
}

export const PREMIUM_PER_CHANNEL = 12;

const CHINA_CONTENT = /央视|卫视|地方|港澳台|国内其他|国内|华语|大陆|cctv|新闻|影视|体育|少儿|纪录|音乐|付费|4k|8k|剧场|电影|其他/i;

const COUNTRY_NAMES: Array<[RegExp, string]> = [
  [/usa|united states/i, '美国'],
  [/india/i, '印度'],
  [/russia/i, '俄罗斯'],
  [/italy/i, '意大利'],
  [/uk|united kingdom|britain/i, '英国'],
  [/germany/i, '德国'],
  [/brazil/i, '巴西'],
  [/poland/i, '波兰'],
  [/sweden/i, '瑞典'],
  [/turkey/i, '土耳其'],
  [/korea/i, '韩国'],
  [/netherlands/i, '荷兰'],
  [/japan/i, '日本'],
  [/france/i, '法国'],
  [/canada/i, '加拿大'],
  [/mexico/i, '墨西哥'],
  [/americas/i, '美洲'],
  [/middle east/i, '中东'],
  [/africa/i, '非洲'],
];

/** Derive the country level from a channel's group title. */
export function countryOfGroup(group: string | null | undefined): string {
  const raw = (group ?? '').trim();
  if (!raw) return '其他';
  const text = raw
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '其他';
  if (/国际|海外/.test(text)) return '国际';
  for (const [pattern, country] of COUNTRY_NAMES) {
    if (pattern.test(text)) return country;
  }
  if (CHINA_CONTENT.test(text)) return '中国';
  if (/^[A-Za-z]/.test(text)) return text;
  return '自定义';
}

export function countryRank(country: string): number {
  if (country === '中国') return 0;
  if (country === '国际') return 1;
  if (country === '自定义') return 2;
  if (country === '其他') return 3;
  return 4;
}

export interface PoolRowChannelMeta {
  id: string;
  name: string;
  group: string;
  tvgId?: string | null;
  logo?: string | null;
}

export interface PoolRowSourceMeta {
  id: string;
  name: string;
  reputation: number;
  tier?: 'high' | 'normal' | 'low';
}

/**
 * Flatten channel-grouped lines into the compact artifact the admin pool reads.
 * Overrides/favorites stay in D1 and are merged by the client; this function
 * only knows the automatic pool classification.
 */
export function buildPoolRows(input: {
  lines: LineEntry[];
  channels: PoolRowChannelMeta[];
  sources: PoolRowSourceMeta[];
  maxLinesPerChannel: number;
  generatedAt: string;
}): PoolRowsSnapshot {
  const channelMap = new Map(input.channels.map((channel) => [channel.id, channel]));
  const sourceMap = new Map(input.sources.map((source) => [source.id, source]));
  const premiumTarget = input.maxLinesPerChannel > 0
    ? Math.max(1, Math.min(PREMIUM_PER_CHANNEL, input.maxLinesPerChannel * 2))
    : Number.MAX_SAFE_INTEGER;

  const byChannel = new Map<string, LineEntry[]>();
  for (const line of dedupePoolLines(input.lines)) {
    const list = byChannel.get(line.channelId) ?? [];
    list.push(line);
    byChannel.set(line.channelId, list);
  }

  const channels: Array<[string, string, string, string]> = [];
  const channelIndex = new Map<string, number>();
  const sources: Array<[string, string, number]> = [];
  const sourceIndex = new Map<string, number>();
  const lines: SlimPoolLine[] = [];

  for (const [channelId, list] of byChannel) {
    const channel = channelMap.get(channelId);
    if (!channel) continue;
    const group = (channel.group ?? '').trim() || '其他';
    let channelPos = channelIndex.get(channelId);
    if (channelPos === undefined) {
      channelPos = channels.length;
      channels.push([channel.id, channel.name, group, countryOfGroup(group)]);
      channelIndex.set(channelId, channelPos);
    }
    let premium = 0;
    for (const line of [...list].sort(compareLines)) {
      let autoPool: PoolRowPool;
      if (!line.lastProbeAt) autoPool = 'pending';
      else if (line.status === 'dead') autoPool = 'rejected';
      else if (line.status === 'suspect') autoPool = 'quarantine';
      else if (line.status === 'alive' && !qualityConfirmed(line)) autoPool = 'candidate';
      else if (premium < premiumTarget) {
        autoPool = 'premium';
        premium++;
      } else autoPool = 'backup';

      let sourcePos = sourceIndex.get(line.sourceId);
      if (sourcePos === undefined) {
        const source = sourceMap.get(line.sourceId);
        sourcePos = sources.length;
        sources.push([line.sourceId, source?.name ?? line.sourceId, source?.reputation ?? 50]);
        sourceIndex.set(line.sourceId, sourcePos);
      }
      const status: PoolRowStatus = line.status === 'alive' || line.status === 'suspect' || line.status === 'dead'
        ? line.status
        : 'unknown';
      lines.push([
        line.key,
        channelPos,
        sourcePos,
        line.name,
        line.resolution ?? '',
        line.height ?? 0,
        line.speedKbps ?? 0,
        line.cnCheckedAt ?? '',
        line.cnLatencyMs ?? 0,
        status,
        line.passCount ?? 0,
        line.lastProbeAt ?? '',
        autoPool,
        line.url.startsWith('https:') ? 'direct' : 'relay',
      ]);
    }
  }

  return { version: 2, generatedAt: input.generatedAt, premiumTarget, channels, sources, lines };
}
