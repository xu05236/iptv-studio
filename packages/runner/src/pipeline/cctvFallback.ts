import { cntvApiCode, type ChannelRegistry, type EpgChannel, type EpgProgramme } from '@iptv/core';
import type { RunLogger } from '../logger.js';

export interface CctvFallbackResult {
  channels: EpgChannel[];
  programmes: EpgProgramme[];
  attempted: number;
  failed: number;
}

export interface CctvFallbackOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  concurrency?: number;
  now?: Date;
}

/** Beijing calendar day as YYYYMMDD — the `d=` value tv.cctv.com uses. */
export function beijingDay(now: Date): string {
  const shifted = new Date(now.getTime() + 8 * 3_600_000);
  return `${shifted.getUTCFullYear()}${String(shifted.getUTCMonth() + 1).padStart(2, '0')}${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

export function cctvFallbackUrl(code: string, now: Date): string {
  return `https://api.cntv.cn/epg/getEpgInfoByChannelNew?c=${encodeURIComponent(code)}&serviceId=tvcctv&d=${beijingDay(now)}`;
}

/**
 * Parse the JSON `tv.cctv.com` renders its schedule page from:
 * `{ data: { <code>: { channelName, list: [{ title, startTime, endTime }] } } }`.
 */
export function parseCctvFallbackPayload(
  payload: unknown,
  code: string,
  channelId: string,
): { channel: EpgChannel; programmes: EpgProgramme[] } | null {
  const entry = (payload as { data?: Record<string, { channelName?: unknown; list?: unknown }> } | null)?.data?.[code];
  const list = Array.isArray(entry?.list) ? entry!.list : [];
  const programmes: EpgProgramme[] = [];
  for (const raw of list) {
    const item = raw as { title?: unknown; startTime?: unknown; endTime?: unknown };
    const title = String(item?.title ?? '').trim();
    const start = Number(item?.startTime) * 1000;
    const stop = Number(item?.endTime) * 1000;
    if (!title || !Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) continue;
    programmes.push({ channelId, start, stop, title });
  }
  if (!programmes.length) return null;
  programmes.sort((a, b) => a.start - b.start);
  const name = String(entry?.channelName ?? '').trim() || channelId;
  return { channel: { id: channelId, names: [name] }, programmes };
}

/**
 * Last-resort guide for CCTV channels that neither XMLTV nor the CNTV adapter
 * covered. One request per channel-day; a failure only logs a warning.
 */
export async function fetchCctvFallback(
  registry: ChannelRegistry,
  covered: Set<string>,
  logger: RunLogger,
  options: CctvFallbackOptions = {},
): Promise<CctvFallbackResult> {
  const now = options.now ?? new Date();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const targets = registry
    .list()
    .filter((seed) => /^cctv/i.test(seed.id) && !covered.has(seed.id))
    .map((seed) => ({ channelId: seed.id, code: cntvApiCode(seed.id) }))
    .filter((item): item is { channelId: string; code: string } => Boolean(item.code));

  const channels: EpgChannel[] = [];
  const programmes: EpgProgramme[] = [];
  let failed = 0;
  for (let index = 0; index < targets.length; index += concurrency) {
    const batch = targets.slice(index, index + concurrency);
    const results = await Promise.all(
      batch.map(async (target) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
        try {
          const response = await fetchImpl(cctvFallbackUrl(target.code, now), {
            signal: controller.signal,
            headers: { 'User-Agent': 'IPTV-Studio-Runner/0.1', Accept: 'application/json' },
          });
          if (!response.ok) {
            logger.warn('CCTV 官方节目表回退失败', { channelId: target.channelId, code: target.code, status: response.status });
            return null;
          }
          const parsed = parseCctvFallbackPayload(await response.json(), target.code, target.channelId);
          if (!parsed) logger.warn('CCTV 官方节目表为空', { channelId: target.channelId, code: target.code });
          return parsed;
        } catch (error) {
          logger.warn('CCTV 官方节目表回退异常', { channelId: target.channelId, code: target.code, error: error instanceof Error ? error.message : String(error) });
          return null;
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    for (const result of results) {
      if (!result) {
        failed += 1;
        continue;
      }
      channels.push(result.channel);
      programmes.push(...result.programmes);
    }
  }
  return { channels, programmes, attempted: targets.length, failed };
}
