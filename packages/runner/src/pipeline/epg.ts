import {
  buildXmltv,
  matchEpg,
  mergeEpg,
  parseXmltv,
  type ChannelRegistry,
  type EpgData,
  type EpgProgramme,
} from '@iptv/core';
import type { RunLogger } from '../logger.js';

export interface EpgResult {
  data: EpgData;
  sources: number;
  programmes: number;
  xml: string;
}

/** Fetch, normalise and merge every configured XMLTV source. */
export async function collectEpg(urls: string[], registry: ChannelRegistry, logger: RunLogger): Promise<EpgResult> {
  const sources: EpgData[] = [];
  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), 90_000);
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'IPTV-Studio-Runner/0.1', Accept: 'application/xml,text/xml,*/*' },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!response.ok) {
        logger.warn('EPG 抓取失败', { url, status: response.status });
        continue;
      }
      const xml = await response.text();
      const parsed = matchEpg(parseXmltv(xml), registry);
      logger.info('EPG 解析完成', { url, channels: parsed.channels.length, programmes: parsed.programmes.length });
      sources.push(parsed);
    } catch (error) {
      logger.warn('EPG 抓取异常', { url, error: error instanceof Error ? error.message : String(error) });
    } finally {
      clearTimeout(timer);
    }
  }

  const data = mergeEpg(sources, { days: 7, lookbackHours: 12 });
  const xml = buildXmltv(data, {
    generator: 'iptv-studio',
    channelNames: new Map(data.channels.map((channel) => [channel.id, channel.names[0] ?? channel.id])),
  });
  logger.info('EPG 合并完成', { sources: sources.length, channels: data.channels.length, programmes: data.programmes.length });
  return { data, sources: sources.length, programmes: data.programmes.length, xml };
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
