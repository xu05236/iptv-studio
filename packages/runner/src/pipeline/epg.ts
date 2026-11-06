import { gunzipSync } from 'node:zlib';
import {
  buildXmltv,
  cntvApiCode,
  EPGPW_ID_MAP,
  mapPool,
  matchEpg,
  mergeEpg,
  parseCctvEpg,
  parseXmltv,
  type ChannelRegistry,
  type EpgChannel,
  type EpgData,
  type EpgProgramme,
  type UnmatchedEpgChannel,
} from '@iptv/core';
import type { RunLogger } from '../logger.js';

export interface EpgSourceMeta {
  provider: string;
  url: string;
  ok: boolean;
  bytes: number;
  channels: number;
  programmes: number;
  error?: string;
}

export interface EpgResult {
  data: EpgData;
  sources: number;
  programmes: number;
  xml: string;
  unmatched: UnmatchedEpgChannel[];
  sourcesReport: EpgSourceMeta[];
}

/** Fetch CNTV's unofficial JSON guide for CCTV and supported satellite channels. */
async function collectCntvEpg(
  registry: ChannelRegistry,
  logger: RunLogger,
): Promise<{ channels: EpgChannel[]; programmes: EpgProgramme[] }> {
  const targets = registry
    .list()
    .map((seed) => ({ id: seed.id, code: cntvApiCode(seed.id) }))
    .filter((item): item is { id: string; code: string } => item.code !== null);

  if (!targets.length) return { channels: [], programmes: [] };

  const channels: EpgChannel[] = [];
  const programmes: EpgProgramme[] = [];

  await mapPool(targets, 4, async ({ id, code }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), 15_000);
    try {
      const response = await fetch(`https://api.cntv.cn/epg/epginfo?c=${encodeURIComponent(code)}&serviceId=tvcctv`, {
        headers: { 'User-Agent': 'IPTV-Studio-Runner/0.1', Referer: 'https://tv.cctv.com/' },
        signal: controller.signal,
      });
      if (!response.ok) return;
      const payload = (await response.json()) as Record<string, never>;
      const parsed = parseCctvEpg(payload, id);
      if (!parsed) return;
      channels.push(parsed.channel);
      programmes.push(...parsed.programmes);
    } catch {
      // CNTV is an enhancement, never a hard dependency
    } finally {
      clearTimeout(timer);
    }
  });

  logger.info('央视/卫视 EPG 完成', { channels: channels.length, programmes: programmes.length });
  return { channels, programmes };
}

/** Fetch, normalise and merge every configured XMLTV source plus CCTV. */
export async function collectEpg(urls: string[], registry: ChannelRegistry, logger: RunLogger, priority: string[] = []): Promise<EpgResult> {
  const ordered = sortUrlsByPriority(urls, priority);
  const sources: EpgData[] = [];
  const metas: EpgSourceMeta[] = [];
  const unmatched: UnmatchedEpgChannel[] = [];
  const cntv = await collectCntvEpg(registry, logger);
  metas.push({ provider: 'api.cntv.cn', url: 'cntv://epg', ok: true, bytes: 0, channels: cntv.channels.length, programmes: cntv.programmes.length });
  for (const url of ordered) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), 90_000);
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'IPTV-Studio-Runner/0.1', Accept: 'application/xml,text/xml,*/*' },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!response.ok) {
        metas.push({ provider: providerLabel(url), url, ok: false, bytes: 0, channels: 0, programmes: 0, error: `HTTP ${response.status}` });
        logger.warn('EPG 抓取失败', { url, status: response.status });
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const xml = buffer[0] === 0x1f && buffer[1] === 0x8b
        ? gunzipSync(buffer).toString('utf8')
        : buffer.toString('utf8');
      const parsed = matchEpg(parseXmltv(xml), registry, {
        idMap: url.includes('epg.pw') ? EPGPW_ID_MAP : undefined,
        provider: providerLabel(url),
        unmatched,
      });
      logger.info('EPG 解析完成', { url, channels: parsed.channels.length, programmes: parsed.programmes.length });
      sources.push(parsed);
      metas.push({
        provider: providerLabel(url),
        url,
        ok: true,
        bytes: buffer.byteLength,
        channels: parsed.channels.length,
        programmes: parsed.programmes.length,
      });
    } catch (error) {
      metas.push({
        provider: providerLabel(url),
        url,
        ok: false,
        bytes: 0,
        channels: 0,
        programmes: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      logger.warn('EPG 抓取异常', { url, error: error instanceof Error ? error.message : String(error) });
    } finally {
      clearTimeout(timer);
    }
  }

  const epgDays = Math.max(1, Number(process.env.EPG_DAYS ?? 2) || 2);
  const epgLookbackHours = Math.max(0, Number(process.env.EPG_LOOKBACK_HOURS ?? 12) || 12);
  const data = mergeEpg(sources, {
    days: epgDays,
    lookbackHours: epgLookbackHours,
    maxProgrammesPerChannel: 180,
  });

  // CNTV wins per (channel, start) slot only: removing every XMLTV programme
  // for those channels used to wipe future days that CNTV does not cover.
  const known = new Set(data.channels.map((channel) => channel.id));
  for (const channel of cntv.channels) {
    if (!known.has(channel.id)) {
      data.channels.push(channel);
      known.add(channel.id);
    }
  }
  const bySlot = new Map(data.programmes.map((programme) => [`${programme.channelId}|${programme.start}`, programme]));
  for (const programme of cntv.programmes) bySlot.set(`${programme.channelId}|${programme.start}`, programme);
  data.programmes = [...bySlot.values()].sort((a, b) => a.start - b.start);

  const xml = buildXmltv(data, {
    generator: 'iptv-studio',
    channelNames: new Map(data.channels.map((channel) => [channel.id, channel.names[0] ?? channel.id])),
  });
  const uniqueUnmatched = [...new Map(unmatched.map((item) => [`${item.provider}|${item.epgName}`, item])).values()];
  logger.info('EPG 合并完成', { sources: sources.length, channels: data.channels.length, programmes: data.programmes.length, unmatched: uniqueUnmatched.length });
  return { data, sources: sources.length, programmes: data.programmes.length, xml, unmatched: uniqueUnmatched, sourcesReport: metas };
}

/** Sort XMLTV URLs by the configured hostname priority (unknown sources last). */
export function sortUrlsByPriority(urls: string[], priority: string[]): string[] {
  if (!priority.length) return urls;
  const rankOf = (url: string): number => {
    const label = providerLabel(url);
    const index = priority.findIndex((item) => label === item || label.endsWith(`.${item}`) || url.includes(item));
    return index === -1 ? priority.length : index;
  };
  return urls
    .map((url, index) => ({ url, index, rank: rankOf(url) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((item) => item.url);
}

/** Provider label for the unmatched report: the source hostname. */
function providerLabel(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export interface GuideProgramme {
  title: string;
  start: number;
  stop?: number;
}

export function nowPlaying(data: EpgData, channelId: string, at = Date.now()): GuideProgramme | undefined {
  const programme = data.programmes.find(
    (item) => item.channelId === channelId && item.start <= at && (item.stop ?? item.start + 3_600_000) > at,
  );
  return programme ? { title: programme.title, start: programme.start, stop: programme.stop } : undefined;
}

export function upcoming(data: EpgData, channelId: string, limit = 3, at = Date.now()): GuideProgramme[] {
  return data.programmes
    .filter((item) => item.channelId === channelId && item.start >= at)
    .slice(0, limit)
    .map((item: EpgProgramme) => ({ title: item.title, start: item.start, stop: item.stop }));
}

/** Compact per-channel guide for the public API (24h, capped). */
export function buildGuide(data: EpgData, channelIds: Set<string>, hours = 24): { generatedAt: string; hours: number; channels: Record<string, GuideProgramme[]> } {
  const now = Date.now();
  const horizon = now + hours * 3_600_000;
  const channels: Record<string, GuideProgramme[]> = {};
  for (const programme of data.programmes) {
    if (!channelIds.has(programme.channelId)) continue;
    if (programme.start > horizon || (programme.stop ?? programme.start) < now - 3_600_000) continue;
    const list = channels[programme.channelId] ?? [];
    if (list.length < 16) list.push({ title: programme.title, start: programme.start, stop: programme.stop });
    channels[programme.channelId] = list;
  }
  return { generatedAt: new Date().toISOString(), hours, channels };
}
