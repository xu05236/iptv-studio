import {
  aggregateChannel,
  applyRules,
  BUCKET_COUNT,
  bucketOf,
  channelLogo,
  channelStats,
  compileRules,
  mapPool,
  selectLines,
  type AppSettings,
  type ChannelConfig,
  type ChannelIndex,
  type ChannelRegistry,
  type ChannelSummary,
  type EpgData,
  type LineEntry,
  type PoolSnapshot,
  type Rule,
} from '@iptv/core';
import type { ArtifactStore } from '../store.js';
import type { RunLogger } from '../logger.js';
import { buildGuide, nowPlaying, upcoming } from './epg.js';
import { matchLogoFile, type LogoPack } from './logoFiles.js';

const GROUP_ORDER = ['央视', '卫视', '地方', '港澳台', '国际', '4K', '影视频道', '体育', '少儿', '纪录', '新闻', '音乐', '付费', '其他'];

type LogoSeed = { id: string; name: string; logo?: string | null; tvgId?: string | null };

function logoForSeed(seed: LogoSeed, input: BuildInput, lineLogos?: Map<string, string>): string | undefined {
  const stored = seed.logo && /^https?:\/\//i.test(seed.logo) ? seed.logo : undefined;
  const fromLine = !stored && !seed.tvgId ? lineLogos?.get(seed.id) : undefined;
  const packMatch = !stored && !fromLine && !seed.tvgId
    ? input.logoPacks
        ?.map((pack) => ({ base: pack.base, file: matchLogoFile(seed.name, pack.files) }))
        .find((item) => item.file)
    : undefined;
  const packLogo = packMatch?.file ? `${packMatch.base.replace(/\/+$/, '')}/${encodeURIComponent(packMatch.file)}` : undefined;
  const matched = !stored && !fromLine && !packLogo && !seed.tvgId ? matchLogoFile(seed.name, input.logoFiles ?? []) : undefined;
  const nameLogo = matched
    ? `https://cdn.jsdelivr.net/gh/fanmingming/live@main/tv/${encodeURIComponent(matched)}`
    : undefined;
  return channelLogo(
    { logo: stored ?? fromLine ?? packLogo ?? nameLogo, tvgId: seed.tvgId, name: seed.name },
    input.settings.logoBaseUrl,
    input.logoProxyBase,
  );
}

export interface BuildInput {
  runId: string;
  generatedAt: string;
  registry: ChannelRegistry;
  lines: LineEntry[];
  settings: AppSettings;
  rules: Rule[];
  epg: EpgData;
  disabledChannelIds?: Set<string>;
  /** Public Worker logo proxy base, e.g. https://host/api/logo. */
  logoProxyBase?: string;
  /** Filenames from the fanmingming logo pack, used to fill name-only channels. */
  logoFiles?: string[];
  /** Multiple packs, tried in order before the legacy logoFiles fallback. */
  logoPacks?: LogoPack[];
}

export interface CatalogItem {
  channel: ChannelConfig;
  lines: LineEntry[];
}

export interface ExportCatalog {
  version: 1;
  runId: string;
  generatedAt: string;
  items: CatalogItem[];
}

export interface ChannelShard {
  channel: ChannelConfig;
  lines: LineEntry[];
  epg?: { now?: { title: string; start: number; stop?: number }; next?: Array<{ title: string; start: number; stop?: number }> };
}

export interface BuildOutput {
  catalog: ExportCatalog;
  index: ChannelIndex;
  shards: Array<{ id: string; data: ChannelShard }>;
  guide: ReturnType<typeof buildGuide>;
  now: Record<string, { title: string; start: number; stop?: number }>;
  channels: Array<{ id: string; name: string; group: string; tvgId?: string; logo?: string }>;
  totalLines: number;
  aliveLines: number;
}

function groupRank(group: string): number {
  const index = GROUP_ORDER.indexOf(group);
  return index === -1 ? GROUP_ORDER.length : index;
}

/** Merge lines into channels, apply rules and produce every artifact payload. */
export function buildArtifacts(input: BuildInput): BuildOutput {
  const compiled = compileRules(input.rules);
  const byChannel = new Map<string, LineEntry[]>();
  for (const line of input.lines) {
    const list = byChannel.get(line.channelId) ?? [];
    list.push(line);
    byChannel.set(line.channelId, list);
  }

  const catalogItems: CatalogItem[] = [];
  const shards: Array<{ id: string; data: ChannelShard }> = [];
  const summaries: ChannelSummary[] = [];
  const nowMap: Record<string, { title: string; start: number; stop?: number }> = {};
  const createdAt = input.generatedAt;
  let totalLines = 0;
  let aliveLines = 0;

  const seeds = input.registry.list().filter((seed) => !input.disabledChannelIds?.has(seed.id));
  seeds.sort((a, b) => groupRank(a.group) - groupRank(b.group) || a.name.localeCompare(b.name, 'zh-CN'));

  // Source metadata often carries a usable tvg-logo even when the channel has
  // no formal id and the logo pack has no matching file.
  const lineLogos = new Map<string, string>();
  for (const line of input.lines) {
    if (line.logo && /^https?:\/\//i.test(line.logo) && !lineLogos.has(line.channelId)) lineLogos.set(line.channelId, line.logo);
  }

  for (const seed of seeds) {
    const lines = byChannel.get(seed.id);
    if (!lines?.length) continue;

    const channel: ChannelConfig = {
      id: seed.id,
      name: seed.name,
      group: seed.group,
      tvgId: seed.tvgId,
      logo: logoForSeed(seed, input, lineLogos),
      aliases: seed.aliases,
    };
    const applied = applyRules(channel, lines, compiled);
    if (!applied.lines.length) continue;

    const aggregated = aggregateChannel(applied.channel, applied.lines, { maxCatalogLines: input.settings.maxLinesPerChannel > 0 ? 40 : 0 });
    const stats = channelStats(aggregated.lines);
    if (stats.alive === 0) continue;
    const exportLines = selectLines(aggregated.lines, {
      maxLines: input.settings.maxLinesPerChannel,
      maxPerSource: input.settings.maxLinesPerSource,
      minQuality: 'any',
      minSpeedKbps: 0,
      compensate: input.settings.compensate,
      keepSuspect: input.settings.keepSuspect,
      relativeFloor: input.settings.maxLinesPerChannel > 0,
    });
    if (!exportLines.length) continue;

    totalLines += aggregated.lines.length;
    aliveLines += stats.alive;

    catalogItems.push({ channel: aggregated.channel, lines: exportLines });

    const epgNow = nowPlaying(input.epg, seed.id);
    if (epgNow) nowMap[seed.id] = epgNow;

    shards.push({
      id: seed.id,
      data: {
        channel: aggregated.channel,
        lines: aggregated.lines,
        epg: { now: epgNow, next: upcoming(input.epg, seed.id, 4) },
      },
    });

    summaries.push({
      id: aggregated.channel.id,
      name: aggregated.channel.name,
      group: aggregated.channel.group,
      tvgId: aggregated.channel.tvgId,
      logo: aggregated.channel.logo,
      enabled: true,
      number: aggregated.channel.number,
      lines: aggregated.lines.length,
      alive: stats.alive,
      bestSpeedKbps: stats.bestSpeedKbps,
      bestResolution: stats.bestQuality === 'unknown' ? undefined : stats.bestQuality,
      sources: stats.sources,
      updatedAt: createdAt,
    });
  }

  const groupMap = new Map<string, { channels: number; alive: number }>();
  for (const summary of summaries) {
    const entry = groupMap.get(summary.group) ?? { channels: 0, alive: 0 };
    entry.channels++;
    entry.alive += summary.alive;
    groupMap.set(summary.group, entry);
  }

  const index: ChannelIndex = {
    generatedAt: createdAt,
    runId: input.runId,
    totalChannels: summaries.length,
    totalLines,
    aliveLines,
    groups: [...groupMap.entries()]
      .map(([group, stats]) => ({ group, ...stats }))
      .sort((a, b) => groupRank(a.group) - groupRank(b.group)),
    channels: summaries,
  };

  const guide = buildGuide(input.epg, new Set(catalogItems.map((item) => item.channel.id)), 24);

  return {
    catalog: { version: 1, runId: input.runId, generatedAt: createdAt, items: catalogItems },
    index,
    shards,
    guide,
    now: nowMap,
    channels: seeds.map((seed) => ({
      id: seed.id,
      name: seed.name,
      group: seed.group,
      tvgId: seed.tvgId,
      logo: logoForSeed(seed, input, lineLogos),
    })),
    totalLines,
    aliveLines,
  };
}

export async function publish(
  store: ArtifactStore,
  output: BuildOutput,
  options: { lines: LineEntry[]; epgXml?: string; log: string; runId: string; generatedAt: string; poolSnapshot?: PoolSnapshot; onProgress?: (done: number, total: number, message: string) => void },
  logger: RunLogger,
): Promise<{ objects: number }> {
  let objects = 0;
  const json = 'application/json; charset=utf-8';
  let artifactCount = 0;
  const artifactTotal = 30;
  const step = (message: string): void => {
    artifactCount++;
    options.onProgress?.(artifactCount, artifactTotal, message);
  };

  await store.put('out/catalog.json', JSON.stringify(output.catalog), json);
  step('catalog.json');
  await store.put('state/index.json', JSON.stringify(output.index), json);
  step('state/index.json');
  const linesPayload = JSON.stringify({ generatedAt: options.generatedAt, lines: options.lines });
  if (new TextEncoder().encode(linesPayload).byteLength > 20 * 1024 * 1024) {
    logger.warn('线路状态接近 KV 24MB 上限，将丢弃已失效超过 24 小时的墓碑线路');
    const cutoff = Date.now() - 24 * 3_600_000;
    const trimmed = options.lines.filter(
      (line) => line.status !== 'dead' || !line.lastProbeAt || new Date(line.lastProbeAt).getTime() > cutoff,
    );
    await store.put('state/lines.json', JSON.stringify({ generatedAt: options.generatedAt, lines: trimmed }), json);
  } else {
    await store.put('state/lines.json', linesPayload, json);
  }
  step('state/lines.json');
  await store.put('state/guide.json', JSON.stringify(output.guide), json);
  await store.put('state/now.json', JSON.stringify({ generatedAt: options.generatedAt, channels: output.now }), json);
  step('guide/now');
  // Subscriptions render from this compact snapshot (tested-alive lines only):
  // it keeps the Worker's hot path small and carries channel metadata for M3U.
  if (options.poolSnapshot) {
    await store.put('state/pool.json', JSON.stringify(options.poolSnapshot), json);
    step('state/pool.json');
    objects++;
  }
  const probeItems = output.shards.flatMap((shard) =>
    shard.data.lines.map((line) => ({
      key: line.key,
      name: line.name,
      channelId: shard.data.channel.id,
      channelName: shard.data.channel.name,
      group: shard.data.channel.group,
      sourceId: line.sourceId,
      status: line.status,
      resolution: line.resolution ?? null,
      speedKbps: line.speedKbps ?? 0,
      latencyMs: line.latencyMs ?? 0,
      protocol: line.protocol,
      codecs: line.codecs,
      failCount: line.failCount,
      score: line.score,
      lastProbeAt: line.lastProbeAt ?? null,
      url: line.url,
      error: line.error ?? null,
      headers: line.headers,
    })),
  );
  await store.put('state/probe.json', JSON.stringify({ generatedAt: options.generatedAt, items: probeItems }), json);
  // F6: 中继热路径用的紧凑索引（key → url + 请求头）。单值一次写，刻意不按 hash 分片；
  // 中继侧不再解析整份 probe.json（20MB 级，单请求 CPU 必超 10ms）。
  const lineIndex = probeItems.map((item) => ({ key: item.key, url: item.url, headers: item.headers }));
  await store.put('state/line-index.json', JSON.stringify({ generatedAt: options.generatedAt, items: lineIndex }), json);
  step('state/line-index.json');
  objects += 7;

  if (options.epgXml) {
    const bytes = new TextEncoder().encode(options.epgXml).byteLength;
    if (bytes > 24 * 1024 * 1024) {
      logger.warn('EPG 超过 KV 单值 24MB 限制，已跳过发布', { mb: Math.round(bytes / 1024 / 1024) });
    } else {
      await store.put('out/epg.xml', options.epgXml, 'application/xml; charset=utf-8');
      step('out/epg.xml');
      objects++;
    }
  }

  // KV free tier allows 1k writes/day. 8 larger buckets are still well below
  // the 24MB value limit and halve the number of writes per publish.
  const buckets = new Map<number, typeof output.shards>();
  for (const shard of output.shards) {
    const index = bucketOf(shard.id, BUCKET_COUNT);
    const list = buckets.get(index) ?? [];
    list.push(shard);
    buckets.set(index, list);
  }
  await mapPool([...buckets.entries()], 4, async ([index, shards]) => {
    await store.put(`state/bucket/${index}.json`, JSON.stringify({ channels: shards.map((shard) => shard.data) }), json);
    step(`bucket ${index + 1}/${buckets.size}`);
  });
  objects += buckets.size;

  const day = options.generatedAt.slice(0, 10);
  await store.put(`snapshots/${day}/catalog.json`, JSON.stringify(output.catalog), json);
  await store.put(`logs/${day}/${options.runId}.jsonl`, options.log, 'application/x-ndjson; charset=utf-8');
  step('log');
  objects += 2;

  // Rollback snapshots are created manually from the admin UI; publishing must
  // not spend 5 extra KV writes on every run.
  step('发布完成');
  logger.info('产物已发布', { objects, buckets: buckets.size, channels: output.catalog.items.length });
  return { objects };
}
