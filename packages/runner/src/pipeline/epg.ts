import { gunzipSync } from 'node:zlib';
import {
  buildXmltv,
  cntvApiCode,
  DEFAULT_EPG_EXCLUDED_GROUPS,
  EPGPW_ID_MAP,
  mapPool,
  matchEpg,
  mergeEpg,
  parseCctvEpg,
  parseXmltv,
  trimEpgData,
  type ChannelRegistry,
  type EpgChannel,
  type EpgData,
  type EpgProgramme,
  type UnmatchedEpgChannel,
} from '@iptv/core';
import type { RunLogger } from '../logger.js';
import { fetchCctvFallback } from './cctvFallback.js';

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

const DIYP_ENDPOINT = 'https://diyp.112114.xyz/?ch=';

/** Parse `2026-11-26 12:30:00` (UTC+8), epoch seconds or epoch ms. */
function parseDiypTime(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 1e12 ? raw : raw * 1000;
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const value = Number(text);
    return value > 1e12 ? value : value * 1000;
  }
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]) - 8, Number(match[5]), Number(match[6] ?? 0));
}

/**
 * DIYP-style per-channel payloads come in a few shapes; accept the common ones
 * and never throw — a miss only costs one request.
 */
export function parseDiypProgrammes(payload: unknown, channelId: string): EpgProgramme[] {
  const root = (payload ?? {}) as Record<string, unknown>;
  const data = (root.data ?? {}) as Record<string, unknown>;
  const candidates = [payload, root.data, root.epg_data, root.epg, root.programs, data.programs, data.epg, data.list];
  let list: unknown[] = [];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      list = candidate;
      break;
    }
  }
  const programmes: EpgProgramme[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const title = String(record.title ?? record.name ?? record.programName ?? record.program ?? '').trim();
    if (!title) continue;
    const start = parseDiypTime(record.start ?? record.start_time ?? record.startTime ?? record.st ?? record.begin ?? record.time);
    if (start === null) continue;
    const stop = parseDiypTime(record.end ?? record.end_time ?? record.endTime ?? record.et ?? record.finish) ?? undefined;
    programmes.push({ channelId, start, stop, title });
  }
  return programmes.sort((left, right) => left.start - right.start);
}

const GENERIC_CHANNEL_NAMES = new Set(['综合', '新闻', '影视', '体育', '少儿', '电影', '电视剧', '娱乐', '音乐', '财经', '纪录', '国际', '港澳', '台湾', '本地', '地方', '测试', '公告', '直播', '频道']);

function looksLikeChannelName(name: string): boolean {
  const text = name.trim();
  if (text.length < 2 || text.length > 30) return false;
  if (/^\d+$/.test(text)) return false;
  if (GENERIC_CHANNEL_NAMES.has(text)) return false;
  return /[\u4e00-\u9fff]/.test(text);
}

/** Speed/quality decorations are duplicates of a clean channel; query clean names first. */
function hasDecoration(name: string): boolean {
  return /\(\s*\d+(?:\.\d+)?\s*(?:MB|KB)\s*\/\s*s\s*\)/i.test(name) || /(?:^|[\s_-])(?:HD|4K|8K|高清|超清)$/i.test(name);
}

async function collectDiypEpg(
  registry: ChannelRegistry,
  coveredIds: Set<string>,
  excludedGroups: string[],
  logger: RunLogger,
): Promise<{ channels: EpgChannel[]; programmes: EpgProgramme[]; attempted: number; ok: number }> {
  const candidates = registry
    .list()
    .filter((seed) => !coveredIds.has(seed.id)
      && !hasDecoration(seed.name)
      && looksLikeChannelName(seed.name)
      && !excludedGroups.includes(seed.group ?? ''))
    .slice(0, 400);
  const channels: EpgChannel[] = [];
  const programmes: EpgProgramme[] = [];
  let ok = 0;
  if (!candidates.length) return { channels, programmes, attempted: 0, ok };
  const deadline = Date.now() + 60_000;
  await mapPool(candidates, 6, async (seed) => {
    if (Date.now() > deadline) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), 4_000);
    try {
      const response = await fetch(DIYP_ENDPOINT + encodeURIComponent(seed.name), {
        headers: { 'User-Agent': 'IPTV-Studio-Runner/0.1', Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) return;
      const parsed = parseDiypProgrammes(await response.json(), seed.id);
      if (!parsed.length) return;
      ok += 1;
      channels.push({ id: seed.id, names: [seed.name] });
      programmes.push(...parsed);
    } catch {
      // Enhancement only: a timeout or bad payload must never fail the EPG run.
    } finally {
      clearTimeout(timer);
    }
  });
  logger.info('112114 单频道补全完成', { candidates: candidates.length, channels: channels.length, programmes: programmes.length });
  return { channels, programmes, attempted: candidates.length, ok };
}

/** Fetch, normalise and merge every configured XMLTV source plus CCTV. */
export async function collectEpg(
  urls: string[],
  registry: ChannelRegistry,
  logger: RunLogger,
  priority: string[] = [],
  options: { excludedGroups?: string[] } = {},
): Promise<EpgResult> {
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

  // Last resort: tv.cctv.com's own channel-day guide (the JSON its schedule
  // page is rendered from) for CCTV channels no source produced programmes for.
  const coveredIds = new Set(data.programmes.map((programme) => programme.channelId));
  const fallback = await fetchCctvFallback(registry, coveredIds, logger);
  if (fallback.attempted) {
    const fallbackKnown = new Set(data.channels.map((channel) => channel.id));
    for (const channel of fallback.channels) {
      if (fallbackKnown.has(channel.id)) continue;
      data.channels.push(channel);
      fallbackKnown.add(channel.id);
    }
    const fallbackSlot = new Map(data.programmes.map((programme) => [`${programme.channelId}|${programme.start}`, programme]));
    for (const programme of fallback.programmes) fallbackSlot.set(`${programme.channelId}|${programme.start}`, programme);
    data.programmes = [...fallbackSlot.values()].sort((a, b) => a.start - b.start);
    metas.push({
      provider: 'tv.cctv.com',
      url: 'cntv://fallback',
      ok: fallback.failed < fallback.attempted,
      bytes: 0,
      channels: fallback.channels.length,
      programmes: fallback.programmes.length,
      error: fallback.failed ? `${fallback.failed}/${fallback.attempted} 个频道失败` : undefined,
    });
  }

  // Last resort 2: query 112114 per channel name for the long tail (county and
  // city stations) that no public XMLTV feed carries. Soft-fails per channel.
  const coveredAfterFallback = new Set(data.programmes.map((programme) => programme.channelId));
  const diyp = await collectDiypEpg(
    registry,
    coveredAfterFallback,
    options.excludedGroups ?? DEFAULT_EPG_EXCLUDED_GROUPS,
    logger,
  );
  if (diyp.channels.length) {
    const diypKnown = new Set(data.channels.map((channel) => channel.id));
    for (const channel of diyp.channels) {
      if (diypKnown.has(channel.id)) continue;
      data.channels.push(channel);
      diypKnown.add(channel.id);
    }
    const diypSlots = new Map(data.programmes.map((programme) => [`${programme.channelId}|${programme.start}`, programme]));
    for (const programme of diyp.programmes) diypSlots.set(`${programme.channelId}|${programme.start}`, programme);
    data.programmes = [...diypSlots.values()].sort((left, right) => left.start - right.start);
  }
  metas.push({
    provider: 'diyp.112114.xyz',
    url: 'diyp://112114',
    ok: diyp.ok > 0 || diyp.attempted === 0,
    bytes: 0,
    channels: diyp.channels.length,
    programmes: diyp.programmes.length,
    error: diyp.attempted && diyp.ok === 0 ? '全部频道无节目单' : undefined,
  });

  // The shared out/epg.xml is a fallback file; keep it comfortably below the
  // 15MB warning line by trimming the window when needed. Per-subscription
  // guides still use the full 24h data.
  const channelNames = new Map(data.channels.map((channel) => [channel.id, channel.names[0] ?? channel.id]));
  const encoder = new TextEncoder();
  let xml = buildXmltv(data, { generator: 'iptv-studio', channelNames });
  if (encoder.encode(xml).byteLength > 15 * 1024 * 1024) {
    const trimmed = trimEpgData(data, { hours: 12, lookbackHours: 1, maxProgrammesPerChannel: 48 });
    xml = buildXmltv(trimmed, { generator: 'iptv-studio', channelNames });
    logger.warn('EPG XML 超过 15MB，已按 12 小时窗口裁剪', {
      channels: trimmed.channels.length,
      programmes: trimmed.programmes.length,
      mb: Math.round(encoder.encode(xml).byteLength / 1048576),
    });
  }
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
  // 30-minute slots is the typical EPG granularity; cap at 2/h plus headroom so
  // a 24h guide is not silently cut off after ~8h (the old fixed 16).
  const maxPerChannel = Math.max(16, Math.ceil(hours * 2));
  for (const programme of data.programmes) {
    if (!channelIds.has(programme.channelId)) continue;
    if (programme.start > horizon || (programme.stop ?? programme.start) < now - 3_600_000) continue;
    const list = channels[programme.channelId] ?? [];
    if (list.length < maxPerChannel) list.push({ title: programme.title, start: programme.start, stop: programme.stop });
    channels[programme.channelId] = list;
  }
  return { generatedAt: new Date().toISOString(), hours, channels };
}

export interface StoredGuide {
  generatedAt?: string;
  hours?: number;
  channels?: Record<string, GuideProgramme[]>;
}

/** True when the stored guide exists, has channels and is younger than `maxAgeHours`. */
export function guideIsFresh(guide: StoredGuide | null, maxAgeHours = 12, now = Date.now()): boolean {
  if (!guide?.channels || !Object.keys(guide.channels).length) return false;
  const at = guide.generatedAt ? Date.parse(guide.generatedAt) : Number.NaN;
  return Number.isFinite(at) && now - at >= 0 && now - at <= maxAgeHours * 3_600_000;
}

/**
 * Keep last-known programmes for channels the new guide does not cover. Public
 * guides regularly drop channels or fail as a whole; without this fallback one
 * bad fetch lowers coverage for every player until the next good run.
 */
export function mergeGuideFallback(previous: StoredGuide | null, next: StoredGuide, hours = 24, now = Date.now()): StoredGuide {
  const channels: Record<string, GuideProgramme[]> = { ...(next.channels ?? {}) };
  const prevAt = previous?.generatedAt ? Date.parse(previous.generatedAt) : Number.NaN;
  const usable = Number.isFinite(prevAt) && now - prevAt >= 0 && now - prevAt <= 72 * 3_600_000;
  const horizon = now + hours * 3_600_000;
  if (usable) {
    for (const [id, list] of Object.entries(previous?.channels ?? {})) {
      if (channels[id]?.length) continue;
      const kept = (list ?? []).filter((item) => (item.stop ?? item.start) >= now - 3_600_000 && item.start <= horizon);
      if (kept.length) channels[id] = kept;
    }
  }
  return { generatedAt: next.generatedAt, hours: next.hours ?? hours, channels };
}
