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
  isDueForProbe,
  mapPool,
  nextReputation,
  normalizeUrlForDedupe,
  probeLiveness,
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
import { prefilterLiveness } from './pipeline/liveness.js';
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
      // D1 rows are often created before tvg-id/logo are known. Never let a
      // null DB column overwrite the builtin seed's identifiers.
      tvgId: row.tvg_id ?? builtin?.tvgId ?? undefined,
      logo: row.logo ?? builtin?.logo ?? undefined,
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

/** Rebuild artifacts/subscriptions from persisted state using the stored guide. */
async function runExport(): Promise<void> {
  const config = loadConfig();
  const logger = new RunLogger();
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = nowIso();
  const startedMs = Date.now();
  const api = new ApiClient(config.apiBaseUrl, config.adminToken);
  const store = new ArtifactStore(api);
  const tombstones = await loadTombstones(api);
  let report: RunReport = {
    id: runId, trigger: 'manual', status: 'running', startedAt,
    sources: 0, channels: 0, lines: 0, alive: 0, dead: 0, probed: 0, bytes: 0, durationMs: 0, warnings: [],
  };

  try {
    const remote = await loadRemoteConfig(api);
    const previousState = await store.getJson<{ lines: LineEntry[] }>('state/lines.json');
    const lines = (previousState?.lines ?? []).filter((line) => !tombstones.has(canonicalPoolUrl(line.url)));
    if (!lines.length) throw new Error('没有线路状态，请先运行 fetch');
    report.sources = remote.sources.length;
    logger.info('仅导出模式', { lines: lines.length });

    const ffprobeLimit = Math.max(0, envNumber('FFPROBE_LIMIT') ?? remote.settings.ffprobeLimit ?? 150);
    if (ffprobeLimit > 0) await enrichResolutions(lines, ffprobeLimit, logger);

    const { output, logKey } = await publishPhase(api, store, config, remote, lines, logger, runId, 'guide');
    report = {
      ...report,
      status: 'success',
      finishedAt: nowIso(),
      channels: output.index.totalChannels,
      lines: output.index.totalLines,
      alive: output.index.aliveLines,
      dead: Math.max(0, output.index.totalLines - output.index.aliveLines),
      durationMs: Date.now() - startedMs,
      logKey,
    };
    await finishRun(api, report);
    logger.info('导出完成', { channels: report.channels, lines: report.lines, alive: report.alive });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('导出失败', { error: message });
    report = { ...report, status: 'failed', finishedAt: nowIso(), error: message, durationMs: Date.now() - startedMs };
    try { report.logKey = await writeLog(store, runId, logger); } catch { /* ignore */ }
    await finishRun(api, report);
    throw error;
  }
}

/** Build and persist the pool snapshot used by pool-driven subscriptions. */
function poolSnapshotFor(remote: RemoteConfig, lines: LineEntry[], generatedAt: string) {
  const registry = buildRegistry(remote);
  return buildPoolSnapshot({
    lines,
    channels: registry.list().map((seed) => ({ id: seed.id, name: seed.name, group: seed.group, tvgId: seed.tvgId, logo: seed.logo })),
    maxLinesPerChannel: remote.settings.maxLinesPerChannel,
    generatedAt,
  });
}

/** Small summary consumed by the Worker scheduler; avoids parsing lines.json. */
function poolStatsFor(remote: RemoteConfig, lines: LineEntry[]) {
  const channelIds = new Set(remote.channels.map((channel) => channel.id));
  const valid = lines.filter((line) => channelIds.has(line.channelId));
  const now = Date.now();
  return {
    generatedAt: new Date().toISOString(),
    total: valid.length,
    pending: valid.filter((line) => !line.lastProbeAt).length,
    quarantine: valid.filter((line) => line.status === 'suspect').length,
    rejected: valid.filter((line) => line.status === 'dead' && (!line.reviveAt || Date.parse(line.reviveAt) <= now)).length,
    alive: valid.filter((line) => line.status === 'alive').length,
    dead: valid.filter((line) => line.status === 'dead').length,
  };
}

async function writePoolStats(store: ArtifactStore, remote: RemoteConfig, lines: LineEntry[]): Promise<void> {
  await store.put('state/pool-stats.json', JSON.stringify(poolStatsFor(remote, lines)), 'application/json');
}

async function syncSourceStats(
  api: ApiClient,
  remote: RemoteConfig,
  lines: LineEntry[],
  collected: CollectedSource[],
): Promise<void> {
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
}

/** Fetch sources and merge them into the line pool. Does not probe or publish. */
async function fetchPhase(
  api: ApiClient,
  remote: RemoteConfig,
  store: ArtifactStore,
  logger: RunLogger,
  previousState: { lines: LineEntry[] } | null,
  tombstones: Set<string>,
): Promise<{ lines: LineEntry[]; collected: CollectedSource[]; sourceId: string }> {
  const settings = remote.settings;
  const sourceId = (process.env.SOURCE_ID ?? '').trim();
  const targetSources = sourceId ? remote.sources.filter((source) => source.id === sourceId) : remote.sources;
  if (sourceId && !targetSources.length) throw new Error(`采集站不存在或已停用：${sourceId}`);

  const collected = await collectAll(targetSources, store, logger);
  const registry = buildRegistry(remote);
  const sources = new Map(remote.sources.map((source) => [source.id, source]));
  const retentionDays = Math.max(0, envNumber('LINE_RETENTION_DAYS') ?? settings.lineRetentionDays ?? 30);
  const normalized = normalize(collected, registry, previousState?.lines ?? [], sources, nowIso(), tombstones, retentionDays);
  const lines = normalized.lines;
  logger.info('线路归一完成', { lines: lines.length, sourceId: sourceId || undefined });
  await writePoolStats(store, remote, lines);
  return { lines, collected, sourceId };
}

/** Probe the line pool in memory; caller persists. No fetch/publish. */
async function probePhase(
  lines: LineEntry[],
  remote: RemoteConfig,
  config: ReturnType<typeof loadConfig>,
  logger: RunLogger,
  sourceId: string,
  cooldown: boolean,
): Promise<{ summary: Awaited<ReturnType<typeof runProbes>> }> {
  const settings = remote.settings;
  const configuredBudget = config.probeBudget || settings.probeBudget;
  const force = process.env.PROBE_FORCE === '1' || process.env.PROBE_FORCE === 'true';
  const baseCandidates = sourceId ? lines.filter((line) => line.sourceId === sourceId) : lines;
  const blockedByLiveness = force
    ? new Set<string>()
    : await prefilterLiveness(baseCandidates, settings, config.concurrency || settings.concurrency || 32, logger);
  const probeCandidates = baseCandidates.filter((line) => !blockedByLiveness.has(line.key));

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

  const sources = new Map(remote.sources.map((source) => [source.id, source]));
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
  const aliveAfter = probeCandidates.filter((line) => line.status === 'alive').length;
  if (aliveBefore >= 20 && summary.probed >= 100 && aliveAfter < aliveBefore * 0.5) {
    throw new Error(`探测异常：可用线路 ${aliveBefore} → ${aliveAfter}，已放弃写入以保护现有订阅`);
  }

  const ffprobeLimit = Math.max(0, envNumber('FFPROBE_LIMIT') ?? settings.ffprobeLimit ?? 150);
  if (ffprobeLimit > 0) {
    await enrichResolutions(sourceId ? lines.filter((line) => line.sourceId === sourceId) : lines, ffprobeLimit, logger);
  }

  if (cooldown) {
    const waitMs = Math.max(0, envNumber('PUBLISH_COOLDOWN_MS') ?? 60_000);
    if (waitMs > 0) {
      logger.info('发布前冷却', { seconds: Math.round(waitMs / 1000) });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  return { summary };
}

/** Build artifacts/EPG and publish. Caller supplies the persisted pool lines. */
async function publishPhase(
  api: ApiClient,
  store: ArtifactStore,
  config: ReturnType<typeof loadConfig>,
  remote: RemoteConfig,
  lines: LineEntry[],
  logger: RunLogger,
  runId: string,
  epgMode: 'fetch' | 'guide',
): Promise<{ output: Awaited<ReturnType<typeof buildArtifacts>>; logKey: string }> {
  const settings = remote.settings;
  const registry = buildRegistry(remote);
  const epg = epgMode === 'fetch'
    ? await collectEpg(settings.epgUrls, registry, logger)
    : { xml: null, programmes: 0, data: epgFromGuide(await store.getJson<StoredGuide>('state/guide.json')) };

  const output = buildArtifacts({
    runId,
    generatedAt: nowIso(),
    registry,
    lines,
    settings,
    rules: remote.rules,
    epg: epg.data,
    disabledChannelIds: new Set(remote.channels.filter((row) => row.enabled === false || row.enabled === 0).map((row) => row.id)),
    logoProxyBase: `${config.publicBaseUrl.replace(/\/+$/, '')}/api/public/logo`,
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
    epgXml: epgMode === 'fetch' ? epg.xml || undefined : undefined,
    log: logger.toJSONL(),
    runId,
    generatedAt: output.catalog.generatedAt,
    poolSnapshot,
  }, logger);
  // A guide-based export keeps the existing per-subscription XMLTV untouched:
  // rebuilding from the compact guide would truncate schedules.
  await publishSubscriptions(api, store, output.catalog, settings, config.publicBaseUrl, epgMode === 'fetch' ? epg.data : null, logger);
  await api.post('/api/admin/sync/channels', { channels: output.channels.map((channel) => ({ ...channel, aliases: [] })) });

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
  return { output, logKey };
}

/** Phase 1 command: fetch + persist lines + source stats. */
async function runFetchPhase(): Promise<void> {
  const config = loadConfig();
  const logger = new RunLogger();
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = nowIso();
  const startedMs = Date.now();
  const api = new ApiClient(config.apiBaseUrl, config.adminToken);
  const store = new ArtifactStore(api);
  const tombstones = await loadTombstones(api);
  let report: RunReport = {
    id: runId, trigger: 'manual', status: 'running', startedAt,
    sources: 0, channels: 0, lines: 0, alive: 0, dead: 0, probed: 0, bytes: 0, durationMs: 0, warnings: [],
  };

  try {
    const remote = await loadRemoteConfig(api);
    const previousState = await store.getJson<{ lines: LineEntry[] }>('state/lines.json');
    report.sources = remote.sources.length;
    const { lines, collected, sourceId } = await fetchPhase(api, remote, store, logger, previousState, tombstones);
    await store.put('state/lines.json', JSON.stringify({ generatedAt: nowIso(), lines }), 'application/json');
    await syncSourceStats(api, remote, lines, collected);

    const alive = lines.filter((line) => line.status === 'alive').length;
    const logKey = await writeLog(store, runId, logger);
    report = {
      ...report,
      status: collected.some((item) => item.error) ? 'partial' : 'success',
      finishedAt: nowIso(),
      channels: remote.channels.length,
      lines: lines.length,
      alive,
      dead: lines.length - alive,
      durationMs: Date.now() - startedMs,
      logKey,
      warnings: collected.filter((item) => item.error).slice(0, 10).map((item) => `${item.source.name}: ${item.error}`),
    };
    await finishRun(api, report);
    logger.info('抓取阶段完成', { lines: lines.length, alive, sourceId: sourceId || undefined });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('抓取阶段失败', { error: message });
    report = { ...report, status: 'failed', finishedAt: nowIso(), error: message, durationMs: Date.now() - startedMs };
    try { report.logKey = await writeLog(store, runId, logger); } catch { /* ignore */ }
    await finishRun(api, report);
    throw error;
  }
}

/** Phase 2 command: probe + persist lines/pool. */
async function runProbePhase(): Promise<void> {
  const config = loadConfig();
  const logger = new RunLogger();
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = nowIso();
  const startedMs = Date.now();
  const api = new ApiClient(config.apiBaseUrl, config.adminToken);
  const store = new ArtifactStore(api);
  let report: RunReport = {
    id: runId, trigger: 'manual', status: 'running', startedAt,
    sources: 0, channels: 0, lines: 0, alive: 0, dead: 0, probed: 0, bytes: 0, durationMs: 0, warnings: [],
  };

  try {
    const remote = await loadRemoteConfig(api);
    const previousState = await store.getJson<{ lines: LineEntry[] }>('state/lines.json');
    const lines = previousState?.lines ?? [];
    if (!lines.length) throw new Error('没有线路状态，请先运行 fetch');
    report.sources = remote.sources.length;
    const sourceId = (process.env.SOURCE_ID ?? '').trim();
    const { summary } = await probePhase(lines, remote, config, logger, sourceId, false);

    const generatedAt = nowIso();
    await store.put('state/lines.json', JSON.stringify({ generatedAt, lines }), 'application/json');
    await store.put('state/pool.json', JSON.stringify(poolSnapshotFor(remote, lines, generatedAt)), 'application/json');
    const logKey = await writeLog(store, runId, logger);
    const alive = lines.filter((line) => line.status === 'alive').length;
    report = {
      ...report,
      status: summary.errors.length ? 'partial' : 'success',
      finishedAt: nowIso(),
      channels: remote.channels.length,
      lines: lines.length,
      alive,
      dead: lines.length - alive,
      probed: summary.probed,
      bytes: summary.bytes,
      durationMs: Date.now() - startedMs,
      logKey,
      warnings: summary.errors.slice(0, 10).map((item) => `${item.url}: ${item.error}`),
    };
    await finishRun(api, report);
    logger.info('探测阶段完成', { probed: summary.probed, alive: summary.alive, dead: summary.dead, mb: Math.round(summary.bytes / 1024 / 1024) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('探测阶段失败', { error: message });
    report = { ...report, status: 'failed', finishedAt: nowIso(), error: message, durationMs: Date.now() - startedMs };
    try { report.logKey = await writeLog(store, runId, logger); } catch { /* ignore */ }
    await finishRun(api, report);
    throw error;
  }
}

function parsePhaseList(value: string): Array<'pending' | 'quarantine' | 'rejected'> {
  const valid = new Set(['pending', 'quarantine', 'rejected']);
  return String(value ?? '')
    .split(/[\s,，]+/)
    .map((item) => item.trim())
    .filter((item): item is 'pending' | 'quarantine' | 'rejected' => valid.has(item));
}

function parsePhaseOrder(value: string): Array<'pending' | 'quarantine' | 'rejected'> {
  const order = parsePhaseList(value);
  return order.length ? order : ['pending', 'quarantine', 'rejected'];
}

function phaseMatches(line: LineEntry, phase: 'pending' | 'quarantine' | 'rejected', now: number, forced: boolean): boolean {
  if (phase === 'pending') return !line.lastProbeAt;
  if (phase === 'quarantine') {
    if (line.status !== 'suspect') return false;
    return forced || isDueForProbe(line, 'normal', new Date(now));
  }
  if (line.status !== 'dead') return false;
  // Permanently dead lines are not worth re-probing.
  if (line.failCount >= 5) return false;
  return forced || !line.reviveAt || Date.parse(line.reviveAt) <= now;
}

/**
 * Automatic batched probing: one phase per run, fixed batch size.
 * pending -> quarantine -> rejected (order/pause configurable), then idle.
 */
async function runBatchProbe(): Promise<void> {
  const config = loadConfig();
  const logger = new RunLogger();
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = nowIso();
  const startedMs = Date.now();
  const api = new ApiClient(config.apiBaseUrl, config.adminToken);
  const store = new ArtifactStore(api);
  let report: RunReport = {
    id: runId, trigger: 'manual', status: 'running', startedAt,
    sources: 0, channels: 0, lines: 0, alive: 0, dead: 0, probed: 0, bytes: 0, durationMs: 0, warnings: [],
  };

  try {
    const remote = await loadRemoteConfig(api);
    const settings = remote.settings;
    const previous = await store.getJson<{ lines: LineEntry[] }>('state/lines.json');
    const lines = previous?.lines ?? [];
    if (!lines.length) throw new Error('没有线路状态，请先运行 fetch');
    const channelIds = new Set(remote.channels.map((channel) => channel.id));
    const now = Date.now();
    const forcedPhase = (process.env.PROBE_PHASE ?? '').trim() as 'pending' | 'quarantine' | 'rejected' | '';
    const paused = new Set(parsePhaseList(settings.probePausedPhases));
    const order = parsePhaseOrder(settings.probePhaseOrder);
    const validPhase = (phase: 'pending' | 'quarantine' | 'rejected'): boolean =>
      channelIds.size > 0 && lines.some((line) => channelIds.has(line.channelId) && phaseMatches(line, phase, now, forcedPhase === phase));
    const phase = forcedPhase && ['pending', 'quarantine', 'rejected'].includes(forcedPhase)
      ? forcedPhase
      : order.find((candidate) => !paused.has(candidate) && validPhase(candidate));
    if (!phase) {
      logger.info('分批探测空闲：没有待测线路');
      report = { ...report, status: 'success', finishedAt: nowIso(), channels: remote.channels.length, lines: lines.length, durationMs: Date.now() - startedMs };
      await finishRun(api, report);
      return;
    }

    const batchSize = Math.max(1, Number(settings.probeBatchSize) || 1200);
    const perChannel = Math.max(1, Number(settings.probePerChannel) || 24);
    const candidates = lines.filter((line) => channelIds.has(line.channelId) && phaseMatches(line, phase, now, Boolean(forcedPhase)));
    const byChannel = new Map<string, LineEntry[]>();
    for (const line of candidates) {
      const bucket = byChannel.get(line.channelId) ?? [];
      bucket.push(line);
      byChannel.set(line.channelId, bucket);
    }
    const picked: LineEntry[] = [];
    for (const bucket of byChannel.values()) {
      bucket.sort((a, b) => (Date.parse(a.lastProbeAt ?? '') || 0) - (Date.parse(b.lastProbeAt ?? '') || 0) || compareLines(a, b));
      picked.push(...bucket.slice(0, perChannel));
    }
    picked.sort((a, b) => (Date.parse(a.lastProbeAt ?? '') || 0) - (Date.parse(b.lastProbeAt ?? '') || 0) || compareLines(a, b));
    const selected = picked.slice(0, batchSize);
    logger.info('分批探测计划', { phase, candidates: candidates.length, batch: selected.length, batchSize, forced: Boolean(forcedPhase) });

    const blocked = phase === 'rejected'
      ? new Set<string>()
      : await prefilterLiveness(selected, settings, config.concurrency || settings.concurrency || 32, logger);
    const probeList = selected.filter((line) => !blocked.has(line.key));
    const summary = await runProbes(probeList, settings, config.concurrency || settings.concurrency, logger);
    const ffprobeLimit = Math.max(0, envNumber('FFPROBE_LIMIT') ?? settings.ffprobeLimit ?? 150);
    if (ffprobeLimit > 0) await enrichResolutions(probeList, ffprobeLimit, logger);
    logger.info('分批探测完成', { phase, checked: selected.length, probed: summary.probed, alive: summary.alive, dead: summary.dead });

    const generatedAt = nowIso();
    await store.put('state/lines.json', JSON.stringify({ generatedAt, lines }), 'application/json');
    await store.put('state/pool.json', JSON.stringify(poolSnapshotFor(remote, lines, generatedAt)), 'application/json');
    await writePoolStats(store, remote, lines);
    const logKey = await writeLog(store, runId, logger);
    const alive = lines.filter((line) => line.status === 'alive').length;
    report = {
      ...report,
      status: summary.errors.length ? 'partial' : 'success',
      finishedAt: nowIso(),
      channels: remote.channels.length,
      lines: lines.length,
      alive,
      dead: lines.length - alive,
      probed: summary.probed,
      bytes: summary.bytes,
      durationMs: Date.now() - startedMs,
      logKey,
      warnings: summary.errors.slice(0, 10).map((item) => `${item.url}: ${item.error}`),
    };
    await finishRun(api, report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('分批探测失败', { error: message });
    report = { ...report, status: 'failed', finishedAt: nowIso(), error: message, durationMs: Date.now() - startedMs };
    try { report.logKey = await writeLog(store, runId, logger); } catch { /* ignore */ }
    await finishRun(api, report);
    throw error;
  }
}

/** Phase 3 command: publish from persisted lines. */async function runPublishPhase(): Promise<void> {
  const config = loadConfig();
  const logger = new RunLogger();
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = nowIso();
  const startedMs = Date.now();
  const api = new ApiClient(config.apiBaseUrl, config.adminToken);
  const store = new ArtifactStore(api);
  let report: RunReport = {
    id: runId, trigger: 'manual', status: 'running', startedAt,
    sources: 0, channels: 0, lines: 0, alive: 0, dead: 0, probed: 0, bytes: 0, durationMs: 0, warnings: [],
  };

  try {
    const remote = await loadRemoteConfig(api);
    const previousState = await store.getJson<{ lines: LineEntry[] }>('state/lines.json');
    const lines = previousState?.lines ?? [];
    if (!lines.length) throw new Error('没有线路状态，请先运行 fetch/probe');
    report.sources = remote.sources.length;
    const { output, logKey } = await publishPhase(api, store, config, remote, lines, logger, runId, 'fetch');
    report = {
      ...report,
      status: 'success',
      finishedAt: nowIso(),
      channels: output.index.totalChannels,
      lines: output.index.totalLines,
      alive: output.index.aliveLines,
      dead: Math.max(0, output.index.totalLines - output.index.aliveLines),
      durationMs: Date.now() - startedMs,
      logKey,
    };
    await finishRun(api, report);
    logger.info('发布阶段完成', { channels: report.channels, lines: report.lines, alive: report.alive });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('发布阶段失败', { error: message });
    report = { ...report, status: 'failed', finishedAt: nowIso(), error: message, durationMs: Date.now() - startedMs };
    try { report.logKey = await writeLog(store, runId, logger); } catch { /* ignore */ }
    await finishRun(api, report);
    throw error;
  }
}

/** One-key collect: fetch -> probe -> publish in one run/report. */
async function runCollectCombined(): Promise<void> {
  const config = loadConfig();
  const logger = new RunLogger();
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = nowIso();
  const startedMs = Date.now();
  const api = new ApiClient(config.apiBaseUrl, config.adminToken);
  const store = new ArtifactStore(api);
  const tombstones = await loadTombstones(api);
  let report: RunReport = {
    id: runId, trigger: (process.env.TRIGGER as RunReport['trigger']) ?? 'schedule',
    status: 'running', startedAt,
    sources: 0, channels: 0, lines: 0, alive: 0, dead: 0, probed: 0, bytes: 0, durationMs: 0, warnings: [],
  };

  try {
    const remote = await loadRemoteConfig(api);
    const previousState = await store.getJson<{ lines: LineEntry[] }>('state/lines.json');
    report.sources = remote.sources.length;
    logger.info('配置加载完成', { sources: remote.sources.length, channels: remote.channels.length, rules: remote.rules.length });

    const { lines, collected, sourceId } = await fetchPhase(api, remote, store, logger, previousState, tombstones);
    const { summary } = await probePhase(lines, remote, config, logger, sourceId, true);
    await syncSourceStats(api, remote, lines, collected);
    const { output, logKey } = await publishPhase(api, store, config, remote, lines, logger, runId, 'fetch');

    report = {
      ...report,
      status: collected.some((item) => item.error) || summary.errors.length ? 'partial' : 'success',
      finishedAt: nowIso(),
      channels: output.index.totalChannels,
      lines: output.index.totalLines,
      alive: output.index.aliveLines,
      dead: Math.max(0, output.index.totalLines - output.index.aliveLines),
      probed: summary.probed,
      bytes: summary.bytes,
      durationMs: Date.now() - startedMs,
      warnings: [
        ...collected.filter((item) => item.error).slice(0, 5).map((item) => `${item.source.name}: ${item.error}`),
        ...summary.errors.slice(0, 5).map((item) => `${item.url}: ${item.error}`),
      ],
      logKey,
    };
    await finishRun(api, report);
    logger.info('运行完成', { runId, channels: report.channels, lines: report.lines, alive: report.alive });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('运行失败', { error: message });
    report = { ...report, status: 'failed', finishedAt: nowIso(), error: message, durationMs: Date.now() - startedMs };
    try { report.logKey = await writeLog(store, runId, logger); } catch { /* ignore */ }
    await finishRun(api, report);
    throw error;
  }
}

/**
 * Lightweight pool recheck: manifest/first-range only. Does not measure speed
 * or resolution, and does not touch lastProbeAt, so the full probe schedule
 * stays intact. Only currently-alive lines are checked; failing three times
 * demotes them like a full probe would.
 */
async function runLiveness(): Promise<void> {
  const config = loadConfig();
  const logger = new RunLogger();
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = nowIso();
  const startedMs = Date.now();
  const api = new ApiClient(config.apiBaseUrl, config.adminToken);
  const store = new ArtifactStore(api);

  let report: RunReport = {
    id: runId,
    trigger: 'manual',
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
    const settings = remote.settings;
    const previous = await store.getJson<{ lines: LineEntry[] }>('state/lines.json');
    const lines = previous?.lines ?? [];
    const dueHours = Math.max(1, envNumber('LINE_LIVENESS_HOURS') ?? 24);
    const budget = Math.max(1, envNumber('PROBE_BUDGET') ?? settings.probeBudget ?? 1200);
    const now = Date.now();
    const seen = new Set<string>();
    const due = lines
      .filter((line) => {
        if (line.status !== 'alive') return false;
        const last = line.lastLivenessAt ? Date.parse(line.lastLivenessAt) : 0;
        if (last && now - last < dueHours * 3_600_000) return false;
        const key = canonicalPoolUrl(line.url);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => {
        const at = (line: LineEntry): number => Date.parse(line.lastLivenessAt ?? line.lastProbeAt ?? '') || 0;
        return at(a) - at(b);
      });
    const selected = due.slice(0, budget);
    logger.info('轻量测活计划', { due: due.length, budget: selected.length, hours: dueHours });

    let alive = 0;
    let failed = 0;
    let skipped = 0;
    const concurrency = Math.max(1, Math.min(config.concurrency || settings.concurrency || 32, 64));
    await mapPool(selected, concurrency, async (line) => {
      const result = await probeLiveness(line.url, { headers: line.headers });
      if (result.inconclusive) {
        skipped++;
        return;
      }
      line.lastLivenessAt = new Date().toISOString();
      if (result.ok) {
        line.status = 'alive';
        line.failCount = 0;
        line.error = undefined;
        alive++;
        return;
      }
      line.failCount = Math.min(99, line.failCount + 1);
      line.error = result.error?.slice(0, 200);
      if (line.failCount >= 3) {
        line.status = 'dead';
        line.reviveAt = new Date(Date.now() + settings.deadReviveDays * 86_400_000).toISOString();
      } else {
        line.status = 'suspect';
      }
      failed++;
    });
    logger.info('轻量测活完成', { checked: selected.length, alive, failed, skipped });

    const generatedAt = nowIso();
    await store.put('state/lines.json', JSON.stringify({ generatedAt, lines }), 'application/json');
    const poolSnapshot = buildPoolSnapshot({
      lines,
      channels: remote.channels.map((channel) => ({ id: channel.id, name: channel.name, group: channel.group_title ?? '其他', tvgId: channel.tvg_id, logo: channel.logo })),
      maxLinesPerChannel: settings.maxLinesPerChannel,
      generatedAt,
    });
    await store.put('state/pool.json', JSON.stringify(poolSnapshot), 'application/json');

    const logKey = await writeLog(store, runId, logger);
    const aliveTotal = lines.filter((line) => line.status === 'alive').length;
    report = {
      ...report,
      status: 'success',
      finishedAt: nowIso(),
      sources: remote.sources.length,
      channels: remote.channels.length,
      lines: lines.length,
      alive: aliveTotal,
      dead: lines.length - aliveTotal,
      probed: selected.length,
      durationMs: Date.now() - startedMs,
      logKey,
    };
    await finishRun(api, report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('轻量测活失败', { error: message });
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

/** Full speed/resolution probe for an explicit set of line keys (detection center). */
async function runSelectedProbes(): Promise<void> {
  const config = loadConfig();
  const logger = new RunLogger();
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = nowIso();
  const startedMs = Date.now();
  const api = new ApiClient(config.apiBaseUrl, config.adminToken);
  const store = new ArtifactStore(api);
  const keys = new Set(
    String(process.env.LINE_KEYS ?? '')
      .split(/[\s,]+/)
      .map((key) => key.trim())
      .filter(Boolean),
  );

  let report: RunReport = {
    id: runId,
    trigger: 'manual',
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
    if (!keys.size) throw new Error('LINE_KEYS 不能为空');
    const remote = await loadRemoteConfig(api);
    const settings = remote.settings;
    const previous = await store.getJson<{ lines: LineEntry[] }>('state/lines.json');
    const lines = previous?.lines ?? [];
    const selected = lines.filter((line) => keys.has(line.key));
    if (!selected.length) throw new Error('选中的线路不存在或已被删除');
    logger.info('选中线路探测计划', { requested: keys.size, matched: selected.length });

    const concurrency = Math.max(1, Math.min(config.concurrency || settings.concurrency || 32, 64));
    const summary = await runProbes(selected, settings, concurrency, logger);
    logger.info('选中线路探测完成', { probed: summary.probed, alive: summary.alive, suspect: summary.suspect, dead: summary.dead });

    const generatedAt = nowIso();
    await store.put('state/lines.json', JSON.stringify({ generatedAt, lines }), 'application/json');
    const poolSnapshot = buildPoolSnapshot({
      lines,
      channels: remote.channels.map((channel) => ({ id: channel.id, name: channel.name, group: channel.group_title ?? '其他', tvgId: channel.tvg_id, logo: channel.logo })),
      maxLinesPerChannel: settings.maxLinesPerChannel,
      generatedAt,
    });
    await store.put('state/pool.json', JSON.stringify(poolSnapshot), 'application/json');

    const logKey = await writeLog(store, runId, logger);
    const aliveTotal = lines.filter((line) => line.status === 'alive').length;
    report = {
      ...report,
      status: 'success',
      finishedAt: nowIso(),
      sources: remote.sources.length,
      channels: remote.channels.length,
      lines: lines.length,
      alive: aliveTotal,
      dead: lines.length - aliveTotal,
      probed: summary.probed,
      bytes: summary.bytes,
      durationMs: Date.now() - startedMs,
      logKey,
      warnings: summary.errors.slice(0, 10).map((item) => `${item.url}: ${item.error}`),
    };
    await finishRun(api, report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('选中线路探测失败', { error: message });
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
  if (command === 'liveness') {
    await runLiveness();
    return;
  }
  if (command === 'fetch') {
    await runFetchPhase();
    return;
  }
  if (command === 'probe') {
    await runProbePhase();
    return;
  }
  if (command === 'publish') {
    await runPublishPhase();
    return;
  }
  if (command === 'probe-batch') {
    await runBatchProbe();
    return;
  }
  if (command === 'probe-lines') {
    await runSelectedProbes();
    return;
  }
  if (command === 'collect') {
    await runCollectCombined();
    return;
  }
  if (command === 'export') {
    await runExport();
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
