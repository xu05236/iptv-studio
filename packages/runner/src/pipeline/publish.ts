import {
  aggregateChannel,
  applyRules,
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
import { matchLogoFile } from './logoFiles.js';

const GROUP_ORDER = ['央视', '卫视', '地方', '港澳台', '国际', '4K', '影视频道', '体育', '少儿', '纪录', '新闻', '音乐', '付费', '其他'];

type LogoSeed = { name: string; logo?: string | null; tvgId?: string | null };

function logoForSeed(seed: LogoSeed, input: BuildInput): string | undefined {
  const stored = seed.logo && /^https?:\/\//i.test(seed.logo) ? seed.logo : undefined;
  const matched = !stored && !seed.tvgId ? matchLogoFile(seed.name, input.logoFiles ?? []) : undefined;
  const nameLogo = matched
    ? `https://cdn.jsdelivr.net/gh/fanmingming/live@main/tv/${encodeURIComponent(matched)}`
    : undefined;
  return channelLogo(
    { logo: stored ?? nameLogo, tvgId: seed.tvgId, name: seed.name },
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

  for (const seed of seeds) {
    const lines = byChannel.get(seed.id);
    if (!lines?.length) continue;

    const channel: ChannelConfig = {
      id: seed.id,
      name: seed.name,
      group: seed.group,
      tvgId: seed.tvgId,
      logo: logoForSeed(seed, input),
      aliases: seed.aliases,
    };
    const applied = applyRules(channel, lines, compiled);
    if (!applied.lines.length) continue;

    const aggregated = aggregateChannel(applied.channel, applied.lines, { maxCatalogLines: 40 });
    const stats = channelStats(aggregated.lines);
    if (stats.alive === 0) continue;
    const exportLines = selectLines(aggregated.lines, {
      maxLines: input.settings.maxLinesPerChannel,
      maxPerSource: input.settings.maxLinesPerSource,
      minQuality: 'any',
      minSpeedKbps: 0,
      compensate: input.settings.compensate,
      keepSuspect: input.settings.keepSuspect,
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
      logo: logoForSeed(seed, input),
    })),
    totalLines,
    aliveLines,
  };
}

export async function publish(
  store: ArtifactStore,
  output: BuildOutput,
  options: { lines: LineEntry[]; epgXml?: string; log: string; runId: string; generatedAt: string; poolSnapshot?: PoolSnapshot },
  logger: RunLogger,
): Promise<{ objects: number }> {
  let objects = 0;
  const json = 'application/json; charset=utf-8';

  await store.put('out/catalog.json', JSON.stringify(output.catalog), json);
  await store.put('state/index.json', JSON.stringify(output.index), json);
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
  await store.put('state/guide.json', JSON.stringify(output.guide), json);
  await store.put('state/now.json', JSON.stringify({ generatedAt: options.generatedAt, channels: output.now }), json);
  // Subscriptions render from this compact snapshot (tested-alive lines only):
  // it keeps the Worker's hot path small and carries channel metadata for M3U.
  if (options.poolSnapshot) {
    await store.put('state/pool.json', JSON.stringify(options.poolSnapshot), json);
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
      headers: line.headers,
    })),
  );
  await store.put('state/probe.json', JSON.stringify({ generatedAt: options.generatedAt, items: probeItems }), json);
  objects += 6;

  if (options.epgXml) {
    const bytes = new TextEncoder().encode(options.epgXml).byteLength;
    if (bytes > 24 * 1024 * 1024) {
      logger.warn('EPG 超过 KV 单值 24MB 限制，已跳过发布', { mb: Math.round(bytes / 1024 / 1024) });
    } else {
      await store.put('out/epg.xml', options.epgXml, 'application/xml; charset=utf-8');
      objects++;
    }
  }

  // KV free tier allows 1k writes/day. 16 larger buckets are a better tradeoff
  // than 64 small ones: fewer writes, still small enough for channel details.
  const buckets = new Map<number, typeof output.shards>();
  for (const shard of output.shards) {
    const index = bucketOf(shard.id, 16);
    const list = buckets.get(index) ?? [];
    list.push(shard);
    buckets.set(index, list);
  }
  await mapPool([...buckets.entries()], 2, async ([index, shards]) => {
    await store.put(`state/bucket/${index}.json`, JSON.stringify({ channels: shards.map((shard) => shard.data) }), json);
  });
  objects += buckets.size;

  const day = options.generatedAt.slice(0, 10);
  await store.put(`snapshots/${day}/catalog.json`, JSON.stringify(output.catalog), json);
  await store.put(`logs/${day}/${options.runId}.jsonl`, options.log, 'application/x-ndjson; charset=utf-8');
  objects += 2;

  // Versioned rollback snapshots (keep 10). Restore writes these back to state.
  if (options.poolSnapshot) {
    const base = `state/snapshots/${options.runId}`;
    await store.put(`${base}/index.json`, JSON.stringify(output.index), json);
    await store.put(`${base}/catalog.json`, JSON.stringify(output.catalog), json);
    await store.put(`${base}/pool.json`, JSON.stringify(options.poolSnapshot), json);
    await store.put(`${base}/guide.json`, JSON.stringify(output.guide), json);
    const manifest = await store.getJson<{ items: Array<Record<string, unknown>> }>('state/snapshots.json');
    const items = (manifest?.items ?? []).filter((item) => item['id'] !== options.runId);
    items.unshift({
      id: options.runId,
      generatedAt: options.generatedAt,
      channels: output.index.totalChannels,
      lines: output.index.totalLines,
      alive: output.index.aliveLines,
      createdAt: new Date().toISOString(),
    });
    await store.put('state/snapshots.json', JSON.stringify({ items: items.slice(0, 10) }), json);
    objects += 5;
  }

  logger.info('产物已发布', { objects, buckets: buckets.size, channels: output.catalog.items.length });
  return { objects };
}
