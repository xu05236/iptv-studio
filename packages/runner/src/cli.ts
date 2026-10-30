import {
  BUILTIN_CHANNELS,
  ChannelRegistry,
  buildPoolSnapshot,
  canonicalPoolUrl,
  classifyGroup,
  compareLines,
  diffCatalogs,
  entryKey,
  formatDiff,
  guessProtocol,
  hashId,
  inferResolution,
  mapPool,
  nextReputation,
  normalizeUrlForDedupe,
  splitUrlHeaders,
  tierFor,
  withinRetention,
  type AppSettings,
  type EpgData,
  type LineEntry,
  type RawEntry,
  type RunReport,
} from '@iptv/core';
import { loadConfig } from './config.js';
import { RunLogger } from './logger.js';
import { notifyTelegram } from './notify.js';
import { ApiClient, ArtifactStore, loadRemoteConfig, type ChannelRecord, type RemoteConfig, type SourceRecord } from './store.js';
import { collectSource, type CollectedSource } from './pipeline/collect.js';
import { planProbes, runProbes } from './pipeline/probe.js';
import { buildArtifacts, publish, type ExportCatalog } from './pipeline/publish.js';
import { collectEpg } from './pipeline/epg.js';
import { publishSubscriptions } from './pipeline/subscriptions.js';
import { captureScreenshots } from './pipeline/screenshots.js';
import { enrichResolutions } from './pipeline/ffprobe.js';

const EMPTY_EPG: EpgData = { channels: [], programmes: [] };

interface StoredGuide {
  channels?: Record<string, Array<{ title: string; start: number; stop?: number }>>;
}

function epgFromGuide(guide: StoredGuide | null): EpgData {
  const channels: EpgData['channels'] = [];
  const programmes: EpgData['programmes'] = [];
  for (const [id, items] of Object.entries(guide?.channels ?? {})) {
    channels.push({ id, names: [id] });
    for (const item of items) programmes.push({ channelId: id, title: item.title, start: item.start, stop: item.stop });
  }
  return { channels, programmes };
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Workflow inputs override admin settings; the settings are the default. */
function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildRegistry(config: RemoteConfig): ChannelRegistry {
  const registry = new ChannelRegistry(BUILTIN_CHANNELS);
  for (const row of config.channels as ChannelRecord[]) {
    const builtin = registry.get(row.id);
    const stored = row.group_title?.trim();
    const group = stored && stored !== '其他'
      ? stored
      : builtin?.group ?? classifyGroup(row.name, stored ?? undefined);
    registry.addChannel({
      id: row.id,
      name: row.name,
      group,
      tvgId: row.tvg_id ?? undefined,
      logo: row.logo ?? undefined,
      // aliases come from the dedicated /meta/aliases map below; the channel
      // list endpoint returns only an alias *count*
      aliases: [],
    });
  }
  for (const [alias, channelId] of Object.entries(config.aliases)) registry.addAlias(alias, channelId);
  return registry;
}

function safeJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalize(
  collected: CollectedSource[],
  registry: ChannelRegistry,
  previousLines: LineEntry[],
  sources: Map<string, SourceRecord>,
  timestamp: string,
  tombstoned: Set<string> = new Set(),
  retentionDays = 30,
): { lines: LineEntry[]; authoritative: Set<string> } {
  const previousByKey = new Map(previousLines.map((line) => [`${line.sourceId}|${line.urlKey}`, line]));
  const authoritative = new Set<string>();
  const merged = new Map<string, LineEntry>();

  for (const item of collected) {
    if (!item.parsed) continue;
    authoritative.add(item.source.id);

    for (const raw of item.entries as RawEntry[]) {
      const { url } = splitUrlHeaders(raw.url);
      const urlKey = normalizeUrlForDedupe(url);
      if (!urlKey) continue;
      if (tombstoned.has(canonicalPoolUrl(url))) continue;

      const source = sources.get(item.source.id);
      const resolved = registry.resolve(raw.name, { tvgId: raw.tvgId, group: raw.group });
      const key = entryKey(item.source.id, urlKey);
      const old = previousByKey.get(`${item.source.id}|${urlKey}`);

      const line: LineEntry = {
        key,
        sourceId: item.source.id,
        sourceIds: [item.source.id],
        channelId: resolved.id,
        name: raw.name,
        url,
        urlKey,
        protocol: guessProtocol(url),
        headers: raw.headers,
        group: raw.group,
        logo: raw.logo,
        status: old?.status ?? 'unknown',
        failCount: old?.failCount ?? 0,
        resolution: old?.resolution ?? inferResolution(`${raw.name} ${url}`),
        width: old?.width,
        height: old?.height,
        frameRate: old?.frameRate,
        bandwidthKbps: old?.bandwidthKbps,
        speedKbps: old?.speedKbps,
        latencyMs: old?.latencyMs,
        score: old?.score ?? 0,
        firstSeenAt: old?.firstSeenAt ?? timestamp,
        lastSeenAt: timestamp,
        lastProbeAt: old?.lastProbeAt,
        reviveAt: old?.reviveAt,
        region: source?.region ?? old?.region,
        operator: source?.operator ?? old?.operator,
        tags: old?.tags ?? [],
        loop: old?.loop,
        catchup: raw.catchup,
        catchupSource: raw.catchupSource,
        catchupDays: raw.catchupDays,
        error: old?.error,
      };
      merged.set(`${line.sourceId}|${line.urlKey}`, line);
    }
  }

  // Sources that returned 304 / failed keep their previous lines instead of
  // being wiped — a bad upstream day must not destroy the catalog.
  for (const old of previousLines) {
    if (authoritative.has(old.sourceId)) continue;
    if (!sources.has(old.sourceId)) continue;
    if (tombstoned.has(canonicalPoolUrl(old.url))) continue;
    const key = `${old.sourceId}|${old.urlKey}`;
    if (!merged.has(key)) merged.set(key, old);
  }

  // A successful refresh is authoritative, but upstreams often drop URLs
  // temporarily. Keep already-tested lines for a retention window instead of
  // wiping them from the pool on the first missing refresh.
  const nowMs = Date.parse(timestamp) || Date.now();
  for (const old of previousLines) {
    if (!authoritative.has(old.sourceId)) continue;
    if (!sources.has(old.sourceId)) continue;
    if (tombstoned.has(canonicalPoolUrl(old.url))) continue;
    const key = `${old.sourceId}|${old.urlKey}`;
    if (merged.has(key)) continue;
    if (!old.lastProbeAt && old.status === 'unknown') continue;
    if (!withinRetention(old.lastSeenAt, nowMs, retentionDays)) continue;
    merged.set(key, old.retained ? old : { ...old, retained: true });
  }

  return { lines: [...merged.values()], authoritative };
}

async function collectAll(
  sources: SourceRecord[],
  store: ArtifactStore,
  logger: RunLogger,
): Promise<CollectedSource[]> {
  return mapPool(sources, 4, async (source) => {
    try {
      return await collectSource(source, store, logger);
    } catch (error) {
      logger.warn('抓取异常', { source: source.name, error: error instanceof Error ? error.message : String(error) });
      return {
        source,
        entries: [],
        fetched: false,
        notModified: false,
        bytes: 0,
        error: error instanceof Error ? error.message : String(error),
      } satisfies CollectedSource;
    }
  });
}

async function writeLog(store: ArtifactStore, runId: string, logger: RunLogger): Promise<string> {  const day = new Date().toISOString().slice(0, 10);
  const key = `logs/${day}/${runId}.jsonl`;
  await store.put(key, logger.toJSONL(), 'application/x-ndjson; charset=utf-8');
  return key;
}

async function finishRun(
  api: ApiClient,
  report: RunReport,
): Promise<void> {
  await api.post('/api/admin/runs', report).catch((error) => {
    console.error('上报运行结果失败', error);
  });
}

/** URLs the operator has permanently retired; they must never be re-imported. */
async function loadTombstones(api: ApiClient): Promise<Set<string>> {
  try {
    const response = await api.get<{ urls?: string[] }>('/api/admin/pool/tombstones');
    return new Set((response.urls ?? []).map((url) => canonicalPoolUrl(url)));
  } catch (error) {
    console.error('读取墓碑失败，本轮不跳过任何线路', error);
    return new Set();
  }
}

async function runCollect(command: 'collect' | 'export'): Promise<void> {
  const config = loadConfig();
  const logger = new RunLogger();
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = nowIso();
  const startedMs = Date.now();
  const api = new ApiClient(config.apiBaseUrl, config.adminToken);
  const store = new ArtifactStore(api);
  const tombstones = await loadTombstones(api);

  let report: RunReport = {
    id: runId,
    trigger: (process.env.TRIGGER as RunReport['trigger']) ?? 'schedule',
    status: 'running',
    startedAt,
    sources: 0,
    channels: 0,
    lines: 0,
    alive: 0,
    dead: 0,
    probed: 0,
    bytes: 0,
    durationMs: 0,
    warnings: [],
  };

  try {
    const remote = await loadRemoteConfig(api);
    const settings: AppSettings = remote.settings;
    report.sources = remote.sources.length;
    logger.info('配置加载完成', { sources: remote.sources.length, channels: remote.channels.length, rules: remote.rules.length });

    const registry = buildRegistry(remote);
    const sources = new Map(remote.sources.map((source) => [source.id, source]));
    const previousState = await store.getJson<{ lines: LineEntry[] }>('state/lines.json');

    let lines: LineEntry[];
    let probed = 0;
    let bytes = 0;

    if (command === 'collect') {
      const sourceId = (process.env.SOURCE_ID ?? '').trim();
      const targetSources = sourceId ? remote.sources.filter((source) => source.id === sourceId) : remote.sources;
      if (sourceId && !targetSources.length) throw new Error(`采集站不存在或已停用：${sourceId}`);
      const collected = await collectAll(targetSources, store, logger);
      const retentionDays = Math.max(0, envNumber('LINE_RETENTION_DAYS') ?? settings.lineRetentionDays ?? 30);
      const normalized = normalize(collected, registry, previousState?.lines ?? [], sources, nowIso(), tombstones, retentionDays);
      // normalize() already keeps previous lines for sources that were skipped,
      // returned 304 or failed; merging them again would duplicate state.
      lines = normalized.lines;
      logger.info('线路归一完成', { lines: lines.length, sourceId: sourceId || undefined });

      const configuredBudget = config.probeBudget || settings.probeBudget;
      const force = process.env.PROBE_FORCE === '1' || process.env.PROBE_FORCE === 'true';
      const probeCandidates = sourceId ? lines.filter((line) => line.sourceId === sourceId) : lines;
      const premium = new Set<string>();
      const byChannel = new Map<string, LineEntry[]>();
      for (const line of probeCandidates) {
        if (line.status !== 'alive') continue;
        const bucket = byChannel.get(line.channelId) ?? [];
        bucket.push(line);
        byChannel.set(line.channelId, bucket);
      }
      for (const bucket of byChannel.values()) {
        bucket.sort(compareLines).slice(0, Math.max(1, settings.maxLinesPerChannel)).forEach((line) => premium.add(line.key));
      }
      // Adaptive budget: probe every line that is actually due, capped by the
      // configured maximum. A small due set no longer reserves the whole cap;
      // a large set still cannot overwhelm the runner.
      const allDue = planProbes(probeCandidates, sources, settings, Number.MAX_SAFE_INTEGER, new Date(), force, premium);
      const budget = configuredBudget > 0 ? Math.min(configuredBudget, allDue.length) : allDue.length;
      const planned = allDue.slice(0, budget);
      logger.info('测速计划', {
        due: allDue.length,
        budget,
        capped: allDue.length > budget,
        force,
        premium: premium.size,
        sourceId: sourceId || undefined,
      });
      const aliveBefore = probeCandidates.filter((line) => line.status === 'alive').length;

      const summary = await runProbes(planned, settings, config.concurrency || settings.concurrency, logger);
      probed = summary.probed;
      bytes = summary.bytes;
      report.bytes = summary.bytes;
      report.probed = summary.probed;
      logger.info('测速完成', { probed: summary.probed, alive: summary.alive, dead: summary.dead, suspect: summary.suspect, mb: Math.round(summary.bytes / 1024 / 1024) });

      const aliveAfter = probeCandidates.filter((line) => line.status === 'alive').length;
      if (aliveBefore >= 20 && summary.probed >= 100 && aliveAfter < aliveBefore * 0.5) {
        throw new Error(`探测异常：可用线路 ${aliveBefore} → ${aliveAfter}，已放弃发布以保护现有订阅（请降低并发或稍后重试）`);
      }

      const ffprobeLimit = Math.max(0, envNumber('FFPROBE_LIMIT') ?? settings.ffprobeLimit ?? 150);
      if (ffprobeLimit > 0) await enrichResolutions(sourceId ? lines.filter((line) => line.sourceId === sourceId) : lines, ffprobeLimit, logger);

      // Mass probing can get the runner IP briefly rate-limited by Cloudflare
      // edges. Cool down before the upload burst so publishing starts clean.
      const cooldown = Math.max(0, envNumber('PUBLISH_COOLDOWN_MS') ?? 60_000);
      if (cooldown > 0) {
        logger.info('发布前冷却', { seconds: Math.round(cooldown / 1000) });
        await new Promise((resolve) => setTimeout(resolve, cooldown));
      }

      const epg = await collectEpg(settings.epgUrls, registry, logger);

      const output = buildArtifacts({
        runId,
        generatedAt: nowIso(),
        registry,
        lines,
        settings,
        rules: remote.rules,
        epg: epg.data,
        disabledChannelIds: new Set(remote.channels.filter((row) => row.enabled === false || row.enabled === 0).map((row) => row.id)),
      });

      const logKey = await writeLog(store, runId, logger);
      const poolSnapshot = buildPoolSnapshot({
        lines,
        channels: registry.list().map((seed) => ({ id: seed.id, name: seed.name, group: seed.group, tvgId: seed.tvgId, logo: seed.logo })),
        maxLinesPerChannel: settings.maxLinesPerChannel,
        generatedAt: output.catalog.generatedAt,
      });
      await publish(store, output, {
        lines,
        epgXml: epg.xml || undefined,
        log: logger.toJSONL(),
        runId,
        generatedAt: output.catalog.generatedAt,
        poolSnapshot,
      }, logger);
      await publishSubscriptions(api, store, output.catalog, settings, config.publicBaseUrl, epg.data, logger);

      // Channel discovery + alias sync
      await api.post('/api/admin/sync/channels', {
        channels: output.channels.map((channel) => ({ ...channel, aliases: [] })),
      });

      // Per-source reputation using this run's measurements
      const stats = remote.sources.map((source) => {
        const sourceLines = lines.filter((line) => line.sourceId === source.id);
        const aliveLines = sourceLines.filter((line) => line.status === 'alive');
        const item = collected.find((entry) => entry.source.id === source.id);
        const reputation = nextReputation({
          previous: source.reputation,
          alive: aliveLines.length,
          total: sourceLines.length,
          avgScore: mean(aliveLines.map((line) => line.score)),
          fetchOk: Boolean(item?.fetched && !item.error),
          consecutiveFailures: item?.error ? 1 : 0,
        });
        return {
          sourceId: source.id,
          // A refresh-interval skip or a 304 means the existing content is
          // still valid; it must not count as a fetch failure.
          fetched: Boolean(item?.fetched || item?.notModified),
          parsed: sourceLines.length,
          alive: aliveLines.length,
          dead: sourceLines.filter((line) => line.status === 'dead').length,
          avgSpeedKbps: mean(aliveLines.map((line) => line.speedKbps ?? 0)),
          avgLatencyMs: mean(aliveLines.map((line) => line.latencyMs ?? 0)),
          etag: item?.etag ?? source.etag,
          lastModified: item?.lastModified ?? source.last_modified,
          error: item?.error,
          reputation,
          tier: tierFor(reputation),
        };
      });
      await api.post('/api/admin/sync/sources', { stats });

      // Diff + notification
      const previousCatalog = await store.getJson<ExportCatalog>('state/prev.json');
      const currentSnapshot = {
        generatedAt: output.catalog.generatedAt,
        channels: output.catalog.items.map((item) => ({
          channel: { id: item.channel.id, name: item.channel.name, group: item.channel.group },
          lines: item.lines,
        })),
      };
      const diff = diffCatalogs(
        previousCatalog
          ? {
              generatedAt: previousCatalog.generatedAt,
              channels: previousCatalog.items.map((item) => ({
                channel: { id: item.channel.id, name: item.channel.name, group: item.channel.group },
                lines: item.lines,
              })),
            }
          : null,
        currentSnapshot,
      );
      logger.info('差异统计', {
        channels: `${diff.channelsBefore}->${diff.channelsAfter}`,
        alive: `${diff.aliveBefore}->${diff.aliveAfter}`,
        added: diff.addedChannels.length,
        removed: diff.removedChannels.length,
      });

      if (settings.notifyTelegram && config.telegram) {
        const sent = await notifyTelegram(config.telegram.botToken, config.telegram.chatId, `<b>IPTV 日报</b>\n${formatDiff(diff)}`);
        logger.info('Telegram 通知', { sent });
      }

      await store.put('state/prev.json', JSON.stringify(output.catalog), 'application/json; charset=utf-8');

      report = {
        ...report,
        status: collected.some((item) => item.error) ? 'partial' : 'success',
        finishedAt: nowIso(),
        channels: output.index.totalChannels,
        lines: output.index.totalLines,
        alive: output.index.aliveLines,
        dead: Math.max(0, output.index.totalLines - output.index.aliveLines),
        durationMs: Date.now() - startedMs,
        warnings: summary.errors.slice(0, 10).map((item) => `${item.url}: ${item.error}`),
        logKey,
      };
      await finishRun(api, report);
      logger.info('运行完成', { runId, channels: report.channels, lines: report.lines, alive: report.alive });
      return;
    }

    // ---- export only: rebuild artifacts from persisted state (no probing) ----
    lines = (previousState?.lines ?? []).filter((line) => !tombstones.has(canonicalPoolUrl(line.url)));
    logger.info('仅导出模式', { lines: lines.length });
    const exportFfprobeLimit = Math.max(0, envNumber('FFPROBE_LIMIT') ?? settings.ffprobeLimit ?? 150);
    if (exportFfprobeLimit > 0) await enrichResolutions(lines, exportFfprobeLimit, logger);
    const previousGuide = await store.getJson<StoredGuide>('state/guide.json');
    const exportEpg = epgFromGuide(previousGuide);
    const output = buildArtifacts({
      runId,
      generatedAt: nowIso(),
      registry,
      lines,
      settings,
      rules: remote.rules,
      epg: exportEpg,
      disabledChannelIds: new Set(remote.channels.filter((row) => row.enabled === false || row.enabled === 0).map((row) => row.id)),
    });
    const logKey = await writeLog(store, runId, logger);
    const poolSnapshot = buildPoolSnapshot({
      lines,
      channels: registry.list().map((seed) => ({ id: seed.id, name: seed.name, group: seed.group, tvgId: seed.tvgId, logo: seed.logo })),
      maxLinesPerChannel: settings.maxLinesPerChannel,
      generatedAt: output.catalog.generatedAt,
    });
    await publish(store, output, { lines, log: logger.toJSONL(), runId, generatedAt: output.catalog.generatedAt, poolSnapshot }, logger);
    // Do not rebuild the per-subscription XMLTV from the compact 24h guide:
    // that truncated players' schedules from 2.5 days to one day. Leaving the
    // existing files alone keeps the full guide written by the last collect.
    await publishSubscriptions(api, store, output.catalog, settings, config.publicBaseUrl, null, logger);
    await api.post('/api/admin/sync/channels', { channels: output.channels.map((channel) => ({ ...channel, aliases: [] })) });
    report = {
      ...report,
      status: 'success',
      finishedAt: nowIso(),
      channels: output.index.totalChannels,
      lines: output.index.totalLines,
      alive: output.index.aliveLines,
      dead: output.index.totalLines - output.index.aliveLines,
      durationMs: Date.now() - startedMs,
      logKey,
      trigger: 'manual',
    };
    await finishRun(api, report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('运行失败', { error: message });
    report = { ...report, status: 'failed', finishedAt: nowIso(), error: message, durationMs: Date.now() - startedMs };
    try {
      report.logKey = await writeLog(store, runId, logger);
    } catch {
      /* ignore */
    }
    await finishRun(api, report);
    throw error;
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'collect';
  if (command === 'collect' || command === 'export') {
    await runCollect(command);
    return;
  }
  if (command === 'epg') {
    const config = loadConfig();
    const logger = new RunLogger();
    const api = new ApiClient(config.apiBaseUrl, config.adminToken);
    const store = new ArtifactStore(api);
    const remote = await loadRemoteConfig(api);
    const registry = buildRegistry(remote);
    const epg = await collectEpg(remote.settings.epgUrls, registry, logger);
    if (epg.xml) {
      const bytes = new TextEncoder().encode(epg.xml).byteLength;
      if (bytes > 24 * 1024 * 1024) {
        logger.warn('EPG 超过 KV 单值限制，未发布', { mb: Math.round(bytes / 1024 / 1024) });
      } else {
        await store.put('out/epg.xml', epg.xml, 'application/xml; charset=utf-8');
        logger.info('EPG 已发布', { mb: Math.round(bytes / 1024 / 1024), programmes: epg.programmes });
      }
    } else {
      logger.warn('没有生成任何节目单内容');
    }
    return;
  }
  if (command === 'shots') {
    const config = loadConfig();
    const logger = new RunLogger();
    const api = new ApiClient(config.apiBaseUrl, config.adminToken);
    const store = new ArtifactStore(api);
    const remote = await loadRemoteConfig(api);
    if (!remote.settings.screenshots) {
      logger.info('截图已关闭（设置 → EPG 与通知）');
      return;
    }
    const limit = Number(process.env.SHOT_LIMIT ?? '60') || 60;
    await captureScreenshots(store, limit, logger);
    return;
  }
  console.error(`未知命令: ${command}（可用: collect | export | epg | shots）`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
