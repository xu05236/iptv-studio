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
  isPurgeable,
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
import { buildGuide, collectEpg } from './pipeline/epg.js';
import { loadLogoPacks } from './pipeline/logoFiles.js';
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

/** EPG source priority from settings: comma separated hostnames, highest first. */
function parseEpgPriority(value: unknown): string[] {
  return String(value ?? '')
    .split(/[,，\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 20);
}

export interface SourceDiff {
  sourceId: string;
  sourceName: string;
  fetched: boolean;
  added: number;
  reused: number;
  retained: number;
  disappeared: number;
  skippedRejected: number;
  skippedTombstoned: number;
}

function normalize(
  collected: CollectedSource[],
  registry: ChannelRegistry,
  previousLines: LineEntry[],
  sources: Map<string, SourceRecord>,
  timestamp: string,
  tombstoned: Set<string> = new Set(),
  retentionDays = 30,
): { lines: LineEntry[]; authoritative: Set<string>; report: SourceDiff[] } {
  const previousByKey = new Map(previousLines.map((line) => [`${line.sourceId}|${line.urlKey}`, line]));
  const authoritative = new Set<string>();
  const merged = new Map<string, LineEntry>();
  const report = new Map<string, SourceDiff>();
  const present = new Set<string>();

  const diffFor = (sourceId: string): SourceDiff => {
    const existing = report.get(sourceId);
    if (existing) return existing;
    const item: SourceDiff = {
      sourceId,
      sourceName: sources.get(sourceId)?.name ?? sourceId,
      fetched: false,
      added: 0,
      reused: 0,
      retained: 0,
      disappeared: 0,
      skippedRejected: 0,
      skippedTombstoned: 0,
    };
    report.set(sourceId, item);
    return item;
  };

  for (const item of collected) {
    if (!item.parsed) continue;
    authoritative.add(item.source.id);
    const diff = diffFor(item.source.id);
    diff.fetched = true;

    for (const raw of item.entries as RawEntry[]) {
      const { url } = splitUrlHeaders(raw.url);
      const urlKey = normalizeUrlForDedupe(url);
      if (!urlKey) continue;
      present.add(`${item.source.id}|${urlKey}`);
      if (tombstoned.has(canonicalPoolUrl(url))) {
        diff.skippedTombstoned++;
        continue;
      }

      const source = sources.get(item.source.id);
      const resolved = registry.resolve(raw.name, { tvgId: raw.tvgId, group: raw.group });
      const key = entryKey(item.source.id, urlKey);
      const old = previousByKey.get(`${item.source.id}|${urlKey}`);
      // 已淘汰是终态：重抓不再把它拉回池子。
      if (old?.status === 'dead') {
        diff.skippedRejected++;
        continue;
      }

      const isOfficial = sourceHasOfficialTag(source);
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
        status: isOfficial ? 'alive' : old?.status ?? 'unknown',
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
        everAlive: old?.everAlive,
        rejectedAt: old?.rejectedAt,
        region: source?.region ?? old?.region,
        operator: source?.operator ?? old?.operator,
        tags: old?.tags ?? [],
        loop: old?.loop,
        catchup: raw.catchup,
        catchupSource: raw.catchupSource,
        catchupDays: raw.catchupDays,
        error: old?.error,
        favorite: old?.favorite,
        official: old?.official ?? isOfficial,
      };
      merged.set(`${line.sourceId}|${line.urlKey}`, line);
      if (old) diff.reused++;
      else diff.added++;
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
    diffFor(old.sourceId).retained++;
  }

  for (const old of previousLines) {
    if (!authoritative.has(old.sourceId)) continue;
    if (!present.has(`${old.sourceId}|${old.urlKey}`)) diffFor(old.sourceId).disappeared++;
  }

  return { lines: [...merged.values()], authoritative, report: [...report.values()] };
}

async function collectSourceWithRetry(source: SourceRecord, store: ArtifactStore, logger: RunLogger): Promise<CollectedSource> {
  // Retries live in the shared fetch layer (fetchText) so they respect the
  // error classification: 4xx/challenge fail fast, 5xx/timeout/network retry.
  try {
    return await collectSource(source, store, logger);
  } catch (error) {
    logger.warn('抓取异常', { source: source.name, error: error instanceof Error ? error.message : String(error) });
    return { source, entries: [], fetched: false, notModified: false, bytes: 0, error: '抓取失败', errorKind: 'network' };
  }
}

function sourceHasOfficialTag(source?: SourceRecord): boolean {
  if (!source?.tags) return false;
  try {
    const tags = typeof source.tags === 'string' ? JSON.parse(source.tags) : source.tags;
    return Array.isArray(tags) && tags.map(String).includes('official');
  } catch {
    return false;
  }
}

async function collectAll(
  sources: SourceRecord[],
  store: ArtifactStore,
  logger: RunLogger,
  onProgress?: (done: number, total: number, label?: string) => void,
): Promise<CollectedSource[]> {
  let done = 0;
  return mapPool(sources, 4, async (source) => {
    try {
      return await collectSourceWithRetry(source, store, logger);
    } finally {
      done++;
      onProgress?.(done, sources.length, source.name);
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
  await api.post('/api/admin/runs', { ...report, taskId: report.taskId ?? process.env.TASK_ID ?? undefined }).catch((error) => {
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

const LIVENESS_RETRY_MS = 6 * 3_600_000;
const UNPROBEABLE_URL = /^(rtsp|rtmp|rtmps|udp|rtp):\/\//i;

function pruneOrphanLines(remote: RemoteConfig, lines: LineEntry[]): { lines: LineEntry[]; removed: number } {
  const channelIds = new Set(remote.channels.map((channel) => channel.id));
  const kept = lines.filter((line) => channelIds.has(line.channelId));
  return { lines: kept, removed: lines.length - kept.length };
}

function livenessReady(line: LineEntry, now: number): boolean {
  if (!line.lastLivenessAt) return true;
  return now - Date.parse(line.lastLivenessAt) >= LIVENESS_RETRY_MS;
}

/** Small summary consumed by the Worker scheduler; avoids parsing lines.json. */
function poolStatsFor(remote: RemoteConfig, lines: LineEntry[]) {
  const channelIds = new Set(remote.channels.map((channel) => channel.id));
  const valid = lines.filter((line) => channelIds.has(line.channelId) && !UNPROBEABLE_URL.test(line.url));
  const now = Date.now();
  const nowDate = new Date(now);
  return {
    generatedAt: new Date().toISOString(),
    total: valid.length,
    // A liveness-prefilter failure becomes suspect without lastProbeAt; it must
    // not stay in pending forever.
    pending: valid.filter((line) => !line.lastProbeAt && line.status === 'unknown').length,
    // Only lines whose TTL is due; otherwise the scheduler would keep dispatching
    // batches that immediately go idle.
    quarantine: valid.filter((line) => line.status === 'suspect' && livenessReady(line, now) && isDueForProbe(line, 'normal', nowDate)).length,
    rejected: valid.filter((line) => line.status === 'dead').length,
    alive: valid.filter((line) => line.status === 'alive').length,
    dead: valid.filter((line) => line.status === 'dead').length,
  };
}

async function writePoolStats(store: ArtifactStore, remote: RemoteConfig, lines: LineEntry[]): Promise<void> {
  await store.put('state/pool-stats.json', JSON.stringify(poolStatsFor(remote, lines)), 'application/json');
}

/** Probe changes alive counts; refresh the source cards without touching reputation. */
async function syncSourceCounts(api: ApiClient, remote: RemoteConfig, lines: LineEntry[]): Promise<void> {
  const counts = remote.sources.map((source) => {
    const sourceLines = lines.filter((line) => line.sourceId === source.id);
    return {
      sourceId: source.id,
      entryCount: sourceLines.length,
      aliveCount: sourceLines.filter((line) => line.status === 'alive').length,
    };
  });
  await api.post('/api/admin/sync/source-counts', { counts }).catch(() => undefined);
}

/** Apply operator line favorites before building exports. */
async function applyLineFavorites(api: ApiClient, lines: LineEntry[]): Promise<void> {
  try {
    const { keys } = await api.get<{ keys: string[] }>('/api/admin/pool/favorites');
    const favorite = new Set(keys);
    for (const line of lines) line.favorite = favorite.has(line.key) || undefined;
  } catch {
    // Export still works without favorites.
  }
}

async function syncSourceStats(
  api: ApiClient,
  remote: RemoteConfig,
  lines: LineEntry[],
  collected: CollectedSource[],
  sourceId?: string,
): Promise<void> {
  const targets = sourceId ? remote.sources.filter((source) => source.id === sourceId) : remote.sources;
  const stats = targets.flatMap((source) => {
    const sourceLines = lines.filter((line) => line.sourceId === source.id);
    const aliveLines = sourceLines.filter((line) => line.status === 'alive');
    const testedLines = sourceLines.filter((line) => line.lastProbeAt && (line.status === 'alive' || line.status === 'dead' || line.status === 'suspect'));
    const item = collected.find((entry) => entry.source.id === source.id);
    // Interval-skipped sources have no fresh result: do not touch their health.
    if (!item || (!item.fetched && !item.error)) return [];
    const reputation = nextReputation({
      previous: source.reputation,
      alive: aliveLines.length,
      total: testedLines.length,
      avgScore: mean(aliveLines.map((line) => line.score)),
      fetchOk: Boolean(item.fetched && !item.error),
      consecutiveFailures: item.error ? 1 : 0,
    });
    return [{
      sourceId: source.id,
      fetched: Boolean(item.fetched),
      parsed: sourceLines.length,
      alive: aliveLines.length,
      dead: sourceLines.filter((line) => line.status === 'dead').length,
      avgSpeedKbps: mean(aliveLines.map((line) => line.speedKbps ?? 0)),
      avgLatencyMs: mean(aliveLines.map((line) => line.latencyMs ?? 0)),
      etag: item.etag ?? source.etag,
      lastModified: item.lastModified ?? source.last_modified,
      error: item.error,
      errorKind: item.errorKind ?? null,
      parseReport: item.parsed
        ? {
            detectedKind: item.parsed.kind,
            entries: item.parsed.entries.length,
            bytes: item.bytes,
            encoding: item.encoding ?? null,
            warnings: (item.parsed.warnings ?? []).slice(0, 10),
            mirrorIndex: item.mirrorIndex ?? 0,
            fetchedAt: new Date().toISOString(),
          }
        : null,
      reputation,
      tier: tierFor(reputation),
    }];
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
  const startedMs = Date.now();

  const collected = await collectAll(targetSources, store, logger, (done, total, label) => {
    void reportTaskProgress(api, done, total, label ? `抓取 ${label}` : '抓取采集站');
  });
  const registry = buildRegistry(remote);
  const sources = new Map(remote.sources.map((source) => [source.id, source]));
  const retentionDays = Math.max(0, envNumber('LINE_RETENTION_DAYS') ?? settings.lineRetentionDays ?? 30);
  const normalized = normalize(collected, registry, previousState?.lines ?? [], sources, nowIso(), tombstones, retentionDays);
  await store.put(
    'state/fetch-report.json',
    JSON.stringify({ generatedAt: nowIso(), sources: normalized.report }),
    'application/json',
  );
  const pruned = pruneOrphanLines(remote, normalized.lines);
  const lines = pruned.lines;
  if (pruned.removed) logger.warn('已剔除孤儿线路', { removed: pruned.removed });
  const okSources = collected.filter((item) => !item.error).length;
  const failedSources = collected.length - okSources;
  const channelCount = new Set(lines.map((line) => line.channelId)).size;
  const added = normalized.report.reduce((sum, item) => sum + item.added, 0);
  const reused = normalized.report.reduce((sum, item) => sum + item.reused, 0);
  const filtered = collected.reduce((sum, item) => sum + (item.filtered ?? 0), 0);
  const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedMs) / 1000));
  const summary = [
    `抓源 ${okSources}/${collected.length} 源成功${failedSources ? `（${failedSources} 失败）` : ''}`,
    `频道 ${channelCount}`,
    `线路 ${lines.length}`,
    `新增 ${added}`,
    `复用 ${reused}`,
    ...(filtered ? [`过滤 ${filtered}`] : []),
    `用时 ${elapsedSeconds}s`,
  ].join(' · ');
  await reportTaskProgress(api, collected.length, collected.length, summary);
  logger.info('线路归一完成', { lines: lines.length, sourceId: sourceId || undefined });
  const stats = poolStatsFor(remote, lines);
  await store.put('state/pool-stats.json', JSON.stringify(stats), 'application/json');
  // 新线路不再直接改写探测计划：调度器按「待测 > 0 + 距上次探测 ≥ 3h + 每天最多 1 批」补探，
  // 其余交给 8 小时窗口，避免每次加源都多开一轮 Actions。
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
  const logoPacks = await loadLogoPacks(store, logger);
  await applyLineFavorites(api, lines);
  await reportTaskProgress(api, 0, 5, '准备发布');
  const epg = epgMode === 'fetch'
    ? await collectEpg(settings.epgUrls, registry, logger, parseEpgPriority(settings.epgSourcePriority))
    : { xml: null, programmes: 0, data: epgFromGuide(await store.getJson<StoredGuide>('state/guide.json')) };
  await reportTaskProgress(api, 1, 5, 'EPG 已准备');
  if ('unmatched' in epg && epg.unmatched.length) {
    await store.put('state/epg-unmatched.json', JSON.stringify({ generatedAt: nowIso(), items: epg.unmatched }), 'application/json; charset=utf-8');
  }
  if ('sourcesReport' in epg && epg.sourcesReport.length) {
    await store.put('state/epg-sources.json', JSON.stringify({ generatedAt: nowIso(), items: epg.sourcesReport }), 'application/json; charset=utf-8');
  }

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
    logoPacks,
  });
  await reportTaskProgress(api, 2, 5, '频道聚合完成');
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
    onProgress: (done, total, message) => {
      void reportTaskProgress(api, done, total, message);
    },
  }, logger);
  await reportTaskProgress(api, 3, 5, '产物写入完成');
  // A guide-based export keeps the existing per-subscription XMLTV untouched:
  // rebuilding from the compact guide would truncate schedules.
  await publishSubscriptions(api, store, output.catalog, settings, config.publicBaseUrl, epgMode === 'fetch' ? epg.data : null, logger);
  if (settings.snapshotOnPublishEnabled) {
    await api.post('/api/admin/snapshots', { origin: 'publish' }).catch((error) => logger.warn('发布后创建快照失败', { error: String(error) }));
  }
  await reportTaskProgress(api, 4, 5, '订阅生成完成');
  const lineChannelIds = new Set(lines.map((line) => line.channelId));
  const syncChannels = output.channels.filter((channel) => !channel.id.startsWith('x-') || lineChannelIds.has(channel.id));
  await api.post('/api/admin/sync/channels', { channels: syncChannels.map((channel) => ({ ...channel, aliases: [] })) });
  await reportTaskProgress(api, 5, 5, '频道元数据同步完成');

  const previousCatalog = await store.getJson<ExportCatalog>('state/prev.json');
  const reportBaseline = await store.getJson<ExportCatalog>('state/report-baseline.json');
  const baselineCatalog = reportBaseline ?? previousCatalog;
  const currentSnapshot = {
    generatedAt: output.catalog.generatedAt,
    channels: output.catalog.items.map((item) => ({
      channel: { id: item.channel.id, name: item.channel.name, group: item.channel.group },
      lines: item.lines,
    })),
  };
  const diff = diffCatalogs(
    baselineCatalog
      ? {
          generatedAt: baselineCatalog.generatedAt,
          channels: baselineCatalog.items.map((item) => ({
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
  const telegram = config.telegram;
  const shouldReport = settings.notifyTelegram && Boolean(telegram) && process.env.TRIGGER === 'schedule' && process.env.AUTO_PUBLISH !== 'true';
  if (shouldReport && telegram) {
    const sent = await notifyTelegram(telegram.botToken, telegram.chatId, `<b>IPTV 日报</b>\n${formatDiff(diff)}`);
    logger.info('Telegram 通知', { sent });
    if (sent) await store.put('state/report-baseline.json', JSON.stringify(output.catalog), 'application/json; charset=utf-8');
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
    await syncSourceStats(api, remote, lines, collected, sourceId);

    const alive = lines.filter((line) => line.status === 'alive').length;
    if (sourceId) {
      const source = remote.sources.find((item) => item.id === sourceId);
      const result = collected.find((item) => item.source.id === sourceId);
      const raw = result?.entries.length ?? 0;
      const stored = lines.filter((line) => line.sourceId === sourceId).length;
      const filtered = Math.max(0, raw - stored);
      const error = result?.error ? ` · 失败：${result.error}` : '';
      await reportTaskProgress(api, 1, 1, `抓取完成 · ${source?.name ?? sourceId} · 原始 ${raw} 条 · 入库 ${stored} 条 · 过滤 ${filtered} 条 · 可用 ${alive}${error}`);
    } else {
      const failed = collected.filter((item) => item.error);
      const detail = failed.length
        ? ` · 失败源：${failed.slice(0, 4).map((item) => `${item.source.name}(${item.error})`).join('、')}`
        : '';
      await reportTaskProgress(api, 1, 1, `抓取完成 · 成功 ${collected.length - failed.length}/${collected.length} 源 · 入库 ${lines.length} 条 · 可用 ${alive}${detail}`);
    }
    const logKey = await writeLog(store, runId, logger);
    report = {
      ...report,
      status: collected.some((item) => item.error) ? 'partial' : 'success',
      finishedAt: nowIso(),
      channels: new Set(lines.map((line) => line.channelId)).size,
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
    await writePoolStats(store, remote, lines);
  await syncSourceCounts(api, remote, lines);
    const logKey = await writeLog(store, runId, logger);
    const alive = lines.filter((line) => line.status === 'alive').length;
    report = {
      ...report,
      status: summary.errors.length ? 'partial' : 'success',
      finishedAt: nowIso(),
      channels: new Set(lines.map((line) => line.channelId)).size,
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

function parsePhaseList(value: string): Array<'pending' | 'quarantine'> {
  const valid = new Set(['pending', 'quarantine']);
  return String(value ?? '')
    .split(/[\s,，]+/)
    .map((item) => item.trim())
    .filter((item): item is 'pending' | 'quarantine' => valid.has(item));
}

function parsePhaseOrder(value: string): Array<'pending' | 'quarantine'> {
  const order = parsePhaseList(value);
  return order.length ? order : ['pending', 'quarantine'];
}

function phaseMatches(line: LineEntry, phase: 'pending' | 'quarantine', now: number, forced: boolean): boolean {
  if (UNPROBEABLE_URL.test(line.url)) return false;
  if (phase === 'pending') return !line.lastProbeAt && line.status === 'unknown';
  if (line.status !== 'suspect') return false;
  if (!forced && !livenessReady(line, now)) return false;
  return forced || isDueForProbe(line, 'normal', new Date(now));
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
    const poolChannels = new Set(lines.map((line) => line.channelId)).size;
    const now = Date.now();
    const forcedPhase = (process.env.PROBE_PHASE ?? '').trim() as 'pending' | 'quarantine' | '';
    const paused = new Set(parsePhaseList(settings.probePausedPhases));
    const order = parsePhaseOrder(settings.probePhaseOrder);
    const validPhase = (phase: 'pending' | 'quarantine'): boolean =>
      channelIds.size > 0 && lines.some((line) => channelIds.has(line.channelId) && phaseMatches(line, phase, now, forcedPhase === phase));
    const phase = forcedPhase && ['pending', 'quarantine'].includes(forcedPhase)
      ? forcedPhase
      : order.find((candidate) => !paused.has(candidate) && validPhase(candidate));
    if (!phase) {
      logger.info('分批探测空闲：没有待测线路');
      await writePoolStats(store, remote, lines);
  await syncSourceCounts(api, remote, lines);
      report = { ...report, status: 'success', finishedAt: nowIso(), channels: poolChannels, lines: lines.length, durationMs: Date.now() - startedMs };
      await finishRun(api, report);
      return;
    }

    const batchSize = Math.max(1, Number(settings.probeBatchSize) || 1200);
    const perChannel = Math.max(1, Number(settings.probePerChannel) || 24);
    const candidates = lines.filter((line) => channelIds.has(line.channelId) && phaseMatches(line, phase, now, Boolean(forcedPhase)));
    const favoriteSources = new Set(remote.sources.filter((source) => source.weight >= 2).map((source) => source.id));
    const favoriteRank = (line: LineEntry): number => (favoriteSources.has(line.sourceId) ? 0 : 1);
    const byChannel = new Map<string, LineEntry[]>();
    for (const line of candidates) {
      const bucket = byChannel.get(line.channelId) ?? [];
      bucket.push(line);
      byChannel.set(line.channelId, bucket);
    }
    const picked: LineEntry[] = [];
    for (const bucket of byChannel.values()) {
      bucket.sort((a, b) => favoriteRank(a) - favoriteRank(b) || (Date.parse(a.lastProbeAt ?? '') || 0) - (Date.parse(b.lastProbeAt ?? '') || 0) || compareLines(a, b));
      picked.push(...bucket.slice(0, perChannel));
    }
    picked.sort((a, b) => favoriteRank(a) - favoriteRank(b) || (Date.parse(a.lastProbeAt ?? '') || 0) - (Date.parse(b.lastProbeAt ?? '') || 0) || compareLines(a, b));
    const selected = picked.slice(0, batchSize);
    const phaseLabel = phase === 'pending' ? '待测' : '待复测';
    logger.info('分批探测计划', { phase, candidates: candidates.length, batch: selected.length, batchSize, forced: Boolean(forcedPhase) });

    const blocked = await prefilterLiveness(selected, settings, config.concurrency || settings.concurrency || 32, logger);
    const probeList = selected.filter((line) => !blocked.has(line.key));
    await reportTaskProgress(api, 0, selected.length, `分批探测 · ${phaseLabel} · 本批 ${selected.length} 条`);
    const summary = await runProbes(probeList, settings, config.concurrency || settings.concurrency, logger, (done) => {
      void reportTaskProgress(api, done, selected.length, `分批探测 · ${phaseLabel} · ${done}/${selected.length}`);
    });
    const ffprobeLimit = Math.max(0, envNumber('FFPROBE_LIMIT') ?? settings.ffprobeLimit ?? 150);
    if (ffprobeLimit > 0) await enrichResolutions(probeList, ffprobeLimit, logger);
    const sourceNames = new Map(remote.sources.map((source) => [source.id, source.name]));
    const bySource = new Map<string, { tested: number; alive: number }>();
    for (const line of probeList) {
      const item = bySource.get(line.sourceId) ?? { tested: 0, alive: 0 };
      item.tested++;
      if (line.status === 'alive') item.alive++;
      bySource.set(line.sourceId, item);
    }
    const sourceDetail = [...bySource.entries()]
      .sort((a, b) => b[1].tested - a[1].tested)
      .slice(0, 8)
      .map(([id, item]) => `${sourceNames.get(id) ?? id} 测${item.tested}/可用${item.alive}`)
      .join('、');
    const sourceSuffix = sourceDetail ? ` · 来源：${sourceDetail}` : '';
    await reportTaskProgress(api, selected.length, selected.length, `分批探测完成 · ${phaseLabel} · 测 ${probeList.length} 条 · 可用 ${summary.alive}${sourceSuffix}`);
    logger.info('分批探测完成', { phase, checked: selected.length, probed: summary.probed, alive: summary.alive, dead: summary.dead });

    const generatedAt = nowIso();
    await store.put('state/lines.json', JSON.stringify({ generatedAt, lines }), 'application/json');
    await store.put('state/pool.json', JSON.stringify(poolSnapshotFor(remote, lines, generatedAt)), 'application/json');
    await writePoolStats(store, remote, lines);
  await syncSourceCounts(api, remote, lines);
    const logKey = await writeLog(store, runId, logger);
    const alive = lines.filter((line) => line.status === 'alive').length;
    report = {
      ...report,
      status: summary.errors.length ? 'partial' : 'success',
      finishedAt: nowIso(),
      channels: new Set(lines.map((line) => line.channelId)).size,
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
    // EPG is refreshed by the daily `epg` task; publishing only rebuilds the
    // line catalog from the stored guide.
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
    await syncSourceStats(api, remote, lines, collected, sourceId);
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
      line.status = 'suspect';
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
    await writePoolStats(store, remote, lines);
  await syncSourceCounts(api, remote, lines);

    const logKey = await writeLog(store, runId, logger);
    const aliveTotal = lines.filter((line) => line.status === 'alive').length;
    report = {
      ...report,
      status: 'success',
      finishedAt: nowIso(),
      sources: remote.sources.length,
      channels: new Set(lines.map((line) => line.channelId)).size,
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

let lastProgressAt = 0;
let lastProgressDone = -1;
let lastProgressMessage = '';

async function reportTaskProgress(api: ApiClient, done: number, total: number, message?: string): Promise<void> {
  const taskId = process.env.TASK_ID;
  if (!taskId) return;
  const now = Date.now();
  const final = total > 0 && done >= total;
  const messageChanged = Boolean(message) && message !== lastProgressMessage;
  if (!final && !messageChanged && now - lastProgressAt < 10_000 && done - lastProgressDone < 50) return;
  lastProgressAt = now;
  lastProgressDone = done;
  if (message) lastProgressMessage = message;
  await api.post(`/api/admin/tasks/${taskId}/progress`, { done, total, message }).catch(() => undefined);
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
    await reportTaskProgress(api, 0, selected.length);
    const summary = await runProbes(selected, settings, concurrency, logger, (done) => {
      void reportTaskProgress(api, done, selected.length);
    });
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
      channels: new Set(lines.map((line) => line.channelId)).size,
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

/** Remove lines whose channel no longer exists in D1. */
async function runCleanupOrphans(): Promise<void> {
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
    const previous = await store.getJson<{ lines: LineEntry[] }>('state/lines.json');
    const pruned = pruneOrphanLines(remote, previous?.lines ?? []);
    const lines = pruned.lines;
    const generatedAt = nowIso();
    await store.put('state/lines.json', JSON.stringify({ generatedAt, lines }), 'application/json');
    await store.put('state/pool.json', JSON.stringify(poolSnapshotFor(remote, lines, generatedAt)), 'application/json');
    await writePoolStats(store, remote, lines);
  await syncSourceCounts(api, remote, lines);
    logger.info('孤儿线路清理完成', { removed: pruned.removed, lines: lines.length });
    const logKey = await writeLog(store, runId, logger);
    const alive = lines.filter((line) => line.status === 'alive').length;
    report = {
      ...report,
      status: 'success',
      finishedAt: nowIso(),
      channels: new Set(lines.map((line) => line.channelId)).size,
      lines: lines.length,
      alive,
      dead: lines.length - alive,
      durationMs: Date.now() - startedMs,
      logKey,
      warnings: pruned.removed ? [`已剔除孤儿线路 ${pruned.removed} 条`] : [],
    };
    await finishRun(api, report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('孤儿清理失败', { error: message });
    report = { ...report, status: 'failed', finishedAt: nowIso(), error: message, durationMs: Date.now() - startedMs };
    try { report.logKey = await writeLog(store, runId, logger); } catch { /* ignore */ }
    await finishRun(api, report);
    throw error;
  }
}

/** 清理超过保留期的已淘汰线路：先写墓碑再删除，避免下次抓源又导入。 */
async function runCleanupRejected(): Promise<void> {
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
    const retention = Math.max(1, Number(settings.rejectedRetentionDays) || 30);
    const expired = lines.filter((line) => line.status === 'dead' && isPurgeable(line, retention, new Date()));
    if (!expired.length) {
      logger.info('没有到期的已淘汰线路', { retention });
      const logKey = await writeLog(store, runId, logger);
      report = {
        ...report, status: 'success', finishedAt: nowIso(),
        channels: new Set(lines.map((line) => line.channelId)).size,
        lines: lines.length, durationMs: Date.now() - startedMs, logKey,
        warnings: [`没有到期的已淘汰线路（保留 ${retention} 天）`],
      };
      await finishRun(api, report);
      return;
    }
    await api.post('/api/admin/pool/tombstone', { urls: [...new Set(expired.map((line) => line.url))], reason: 'retention' });
    const removed = new Set(expired.map((line) => line.key));
    const kept = lines.filter((line) => !removed.has(line.key));
    const generatedAt = nowIso();
    await store.put('state/lines.json', JSON.stringify({ generatedAt, lines: kept }), 'application/json');
    await store.put('state/pool.json', JSON.stringify(poolSnapshotFor(remote, kept, generatedAt)), 'application/json');
    await writePoolStats(store, remote, kept);
    await syncSourceCounts(api, remote, kept);
    logger.info('已淘汰线路清理完成', { removed: expired.length, lines: kept.length });
    const logKey = await writeLog(store, runId, logger);
    const alive = kept.filter((line) => line.status === 'alive').length;
    report = {
      ...report, status: 'success', finishedAt: nowIso(),
      channels: new Set(kept.map((line) => line.channelId)).size,
      lines: kept.length, alive, dead: kept.length - alive,
      durationMs: Date.now() - startedMs, logKey,
      warnings: [`已淘汰线路清理 ${expired.length} 条`],
    };
    await finishRun(api, report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('已淘汰线路清理失败', { error: message });
    report = { ...report, status: 'failed', finishedAt: nowIso(), error: message, durationMs: Date.now() - startedMs };
    try { report.logKey = await writeLog(store, runId, logger); } catch { /* ignore */ }
    await finishRun(api, report);
    throw error;
  }
}

/** 月末抽检/整批复活：把已淘汰线路拉回待测，只探测一次，失败重新淘汰。 */
async function runReviveBatch(): Promise<void> {
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
    const budget = Math.max(1, Number(process.env.PROBE_BUDGET || settings.monthlyReviveBatchSize) || 800);
    const selected = lines
      .filter((line) => line.status === 'dead')
      .sort((left, right) => String(left.rejectedAt ?? '').localeCompare(String(right.rejectedAt ?? '')))
      .slice(0, budget);
    if (!selected.length) {
      logger.info('没有可复活的已淘汰线路');
      const logKey = await writeLog(store, runId, logger);
      report = {
        ...report, status: 'success', finishedAt: nowIso(),
        channels: new Set(lines.map((line) => line.channelId)).size,
        lines: lines.length, durationMs: Date.now() - startedMs, logKey,
        warnings: ['没有可复活的已淘汰线路'],
      };
      await finishRun(api, report);
      return;
    }
    for (const line of selected) {
      line.status = 'unknown';
      line.failCount = 0;
      line.lastProbeAt = undefined;
      delete line.rejectedAt;
    }
    logger.info('复活抽检计划', { selected: selected.length, budget });
    const concurrency = Math.max(1, Math.min(config.concurrency || settings.concurrency || 32, 64));
    await reportTaskProgress(api, 0, selected.length);
    const summary = await runProbes(selected, settings, concurrency, logger, (done) => {
      void reportTaskProgress(api, done, selected.length);
    });
    const now = new Date();
    for (const line of selected) {
      if (line.status !== 'alive') {
        line.status = 'dead';
        line.rejectedAt = now.toISOString();
      }
    }
    const generatedAt = nowIso();
    await store.put('state/lines.json', JSON.stringify({ generatedAt, lines }), 'application/json');
    await store.put('state/pool.json', JSON.stringify(poolSnapshotFor(remote, lines, generatedAt)), 'application/json');
    await writePoolStats(store, remote, lines);
    await syncSourceCounts(api, remote, lines);
    logger.info('复活抽检完成', { probed: summary.probed, alive: summary.alive, failedAgain: selected.length - summary.alive });
    const logKey = await writeLog(store, runId, logger);
    const aliveTotal = lines.filter((line) => line.status === 'alive').length;
    report = {
      ...report, status: 'success', finishedAt: nowIso(),
      channels: new Set(lines.map((line) => line.channelId)).size,
      lines: lines.length, alive: aliveTotal, dead: lines.length - aliveTotal,
      probed: summary.probed,
      bytes: summary.bytes,
      durationMs: Date.now() - startedMs, logKey,
      warnings: [
        `复活抽检 ${selected.length} 条，成功 ${summary.alive} 条`,
        ...summary.errors.slice(0, 10).map((item) => `${item.url}: ${item.error}`),
      ],
    };
    await finishRun(api, report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('复活抽检失败', { error: message });
    report = { ...report, status: 'failed', finishedAt: nowIso(), error: message, durationMs: Date.now() - startedMs };
    try { report.logKey = await writeLog(store, runId, logger); } catch { /* ignore */ }
    await finishRun(api, report);
    throw error;
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'collect';
  if (command === 'cleanup-orphans') {
    await runCleanupOrphans();
    return;
  }
  if (command === 'cleanup-rejected') {
    await runCleanupRejected();
    return;
  }
  if (command === 'revive-batch') {
    await runReviveBatch();
    return;
  }
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
    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const startedAt = nowIso();
    const startedMs = Date.now();
    try {
      const remote = await loadRemoteConfig(api);
      const registry = buildRegistry(remote);
      const previousGuide = await store.getJson<StoredGuide>('state/guide.json');
      const previousIds = new Set(Object.keys(previousGuide?.channels ?? {}));
      const epg = await collectEpg(remote.settings.epgUrls, registry, logger, parseEpgPriority(remote.settings.epgSourcePriority));
      if (epg.unmatched.length) {
        await store.put('state/epg-unmatched.json', JSON.stringify({ generatedAt: nowIso(), items: epg.unmatched }), 'application/json; charset=utf-8');
      }
      if (epg.sourcesReport.length) {
        await store.put('state/epg-sources.json', JSON.stringify({ generatedAt: nowIso(), items: epg.sourcesReport }), 'application/json; charset=utf-8');
      }
      let bytes = 0;
      if (epg.xml) {
        bytes = new TextEncoder().encode(epg.xml).byteLength;
        if (bytes > 24 * 1024 * 1024) {
          logger.warn('EPG 超过 KV 单值限制，未发布', { mb: Math.round(bytes / 1024 / 1024) });
        } else {
          await store.put('out/epg.xml', epg.xml, 'application/xml; charset=utf-8');
          logger.info('EPG 已发布', { mb: Math.round(bytes / 1024 / 1024), programmes: epg.programmes });
        }
        const catalog = await store.getJson<ExportCatalog>('out/catalog.json');
        if (catalog) {
          await publishSubscriptions(api, store, catalog, remote.settings, config.publicBaseUrl, epg.data, logger);
        }
        await store.put(
          'state/guide.json',
          JSON.stringify(buildGuide(epg.data, new Set(remote.channels.map((channel) => channel.id)), 24)),
          'application/json; charset=utf-8',
        );
      } else {
        logger.warn('没有生成任何节目单内容');
      }
      const nextIds = new Set(epg.data.channels.map((channel) => channel.id));
      const added = [...nextIds].filter((id) => !previousIds.has(id)).length;
      const removed = [...previousIds].filter((id) => !nextIds.has(id)).length;
      await reportTaskProgress(api, 1, 1, `EPG 刷新完成 · ${nextIds.size} 频道 · ${epg.programmes} 节目 · 新增 ${added} · 删除 ${removed}`);
      await finishRun(api, {
        id: runId, trigger: 'manual', status: 'success', startedAt, finishedAt: nowIso(),
        sources: remote.sources.length, channels: nextIds.size, lines: 0, alive: 0, dead: 0,
        probed: 0, bytes, durationMs: Date.now() - startedMs, warnings: [],
      });
    } catch (error) {
      await finishRun(api, {
        id: runId, trigger: 'manual', status: 'failed', startedAt, finishedAt: nowIso(),
        sources: 0, channels: 0, lines: 0, alive: 0, dead: 0, probed: 0, bytes: 0,
        durationMs: Date.now() - startedMs, warnings: [], error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      throw error;
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