import {
  applyRules,
  compileRules,
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
  lineSignature,
  pickDuplicateOwner,
  mergedChannelId,
  isMergedChannelId,
  activeProbeProfile,
  type AppSettings,
  type ChannelConfig,
  type EpgData,
  type LineEntry,
  type RawEntry,
  type ResolvedChannel,
  type RunReport,
} from '@iptv/core';
import { loadConfig } from './config.js';
import { MERGED_PROBE_PER_CHANNEL, selectProbeLines } from './pipeline/probeSelection.js';
import { RunLogger, redact, redactError } from './logger.js';
import { notifyTelegram } from './notify.js';
import { ApiClient, ArtifactStore, loadRemoteConfig, type ChannelRecord, type RemoteConfig, type SourceRecord } from './store.js';
import { collectSource, type CollectedSource } from './pipeline/collect.js';
import { dedupeProbeTargets, fanoutProbeResults, planProbes, runProbes } from './pipeline/probe.js';
import { buildArtifacts, publish, type ExportCatalog } from './pipeline/publish.js';
import { buildGuide, collectEpg, guideIsFresh, mergeGuideFallback, type StoredGuide } from './pipeline/epg.js';
import { loadLogoPacks } from './pipeline/logoFiles.js';
import { loadLinesState, saveLinesState } from './lib/linesState.js';
import { fetchViaProxy, probeProxy } from './lib/proxyFetch.js';
import { activateRuntimeProxy, isKernelProxy, isUdpOnlyProxy, probeRuntimeProxy } from './lib/proxyRuntime.js';
import { buildProxyAgent, probeCnUrl } from './pipeline/cnProbe.js';
import { prefilterLiveness } from './pipeline/liveness.js';
import { publishSubscriptions } from './pipeline/subscriptions.js';
import { captureScreenshots } from './pipeline/screenshots.js';
import { enrichResolutions } from './pipeline/ffprobe.js';

const EMPTY_EPG: EpgData = { channels: [], programmes: [] };

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

export interface SourceStatusCounts {
  total: number;
  alive: number;
  pending: number;
  quarantine: number;
  rejected: number;
}

export interface SourceDiff {
  sourceId: string;
  sourceName: string;
  fetched: boolean;
  fetchedAt: string;
  parsed: number;
  added: number;
  reused: number;
  reusedAlive: number;
  reusedPending: number;
  reusedQuarantine: number;
  reusedOther: number;
  retained: number;
  disappeared: number;
  skippedRejected: number;
  skippedTombstoned: number;
  skippedDuplicate: number;
  before: SourceStatusCounts;
  after: SourceStatusCounts;
}

const emptyStatusCounts = (): SourceStatusCounts => ({ total: 0, alive: 0, pending: 0, quarantine: 0, rejected: 0 });

/** Count lines the same way the source card does (alive / untested / suspect / dead). */
function countLineStatuses(lines: LineEntry[]): Map<string, SourceStatusCounts> {
  const bySource = new Map<string, SourceStatusCounts>();
  for (const line of lines) {
    const counts = bySource.get(line.sourceId) ?? emptyStatusCounts();
    counts.total += 1;
    if (line.status === 'alive') counts.alive += 1;
    else if (!/^(rtsp|rtmp|rtmps|udp|rtp):\/\//i.test(line.url)) {
      if (line.status === 'suspect') counts.quarantine += 1;
      else if (line.status === 'dead') counts.rejected += 1;
      else if (!line.lastProbeAt) counts.pending += 1;
    }
    bySource.set(line.sourceId, counts);
  }
  return bySource;
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
  const beforeBySource = countLineStatuses(previousLines);
  const authoritative = new Set<string>();
  const merged = new Map<string, LineEntry>();
  const report = new Map<string, SourceDiff>();
  const present = new Set<string>();
  // One copy per URL+headers: later sources must not re-import a URL another
  // source already owns (mirrors would otherwise grow the state forever).
  const bySignature = new Map<string, LineEntry[]>();
  for (const line of previousLines) {
    const signature = lineSignature(line);
    const bucket = bySignature.get(signature) ?? [];
    bucket.push(line);
    bySignature.set(signature, bucket);
  }
  const removed = new Set<string>();

  const diffFor = (sourceId: string): SourceDiff => {
    const existing = report.get(sourceId);
    if (existing) return existing;
    const item: SourceDiff = {
      sourceId,
      sourceName: sources.get(sourceId)?.name ?? sourceId,
      fetched: false,
      fetchedAt: timestamp,
      parsed: 0,
      added: 0,
      reused: 0,
      reusedAlive: 0,
      reusedPending: 0,
      reusedQuarantine: 0,
      reusedOther: 0,
      retained: 0,
      disappeared: 0,
      skippedRejected: 0,
      skippedTombstoned: 0,
      skippedDuplicate: 0,
      before: beforeBySource.get(sourceId) ?? emptyStatusCounts(),
      after: emptyStatusCounts(),
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
      diff.parsed += 1;
      present.add(`${item.source.id}|${urlKey}`);
      if (tombstoned.has(canonicalPoolUrl(url))) {
        diff.skippedTombstoned++;
        continue;
      }

      const source = sources.get(item.source.id);
      // Live-platform sources (虎牙/斗鱼) can be folded into one channel so the
      // hundreds of stream rooms stay one "channel" with many lines. The id is
      // deterministic so exports can recognise merged channels.
      const mergeName = (source?.mergeChannelName ?? source?.merge_channel_name ?? '').trim();
      let resolved: ResolvedChannel;
      if (mergeName) {
        const id = mergedChannelId(item.source.id);
        const group = (source?.mergeChannelGroup ?? source?.merge_channel_group ?? '').trim() || '影视';
        if (!registry.get(id)) registry.addChannel({ id, name: mergeName, group });
        resolved = { id, name: mergeName, group, confidence: 1, created: false };
      } else {
        // No merge name: keep the source's own line names as channels, but let
        // the source force a shared group (e.g. 虎牙频道) for those channels.
        const groupOverride = (source?.mergeChannelGroup ?? source?.merge_channel_group ?? '').trim();
        resolved = registry.resolve(raw.name, { tvgId: raw.tvgId, group: groupOverride || raw.group });
      }
      const key = entryKey(item.source.id, urlKey);
      const old = previousByKey.get(`${item.source.id}|${urlKey}`);
      // 已淘汰是终态：重抓不再把它拉回池子。
      if (old?.status === 'dead') {
        diff.skippedRejected++;
        continue;
      }

      const isOfficial = sourceHasOfficialTag(source);
      const signature = lineSignature({ urlKey, headers: raw.headers });
      const owner = pickDuplicateOwner(bySignature.get(signature) ?? []);
      if (!isOfficial && owner && owner.sourceId !== item.source.id) {
        if (owner.status !== 'dead') {
          diff.skippedDuplicate += 1;
          continue;
        }
        // The owning copy is dead: let this fresh line take over the URL.
        for (const dead of bySignature.get(signature) ?? []) {
          if (dead.status === 'dead') removed.add(`${dead.sourceId}|${dead.urlKey}`);
        }
      }
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
      const bucket = bySignature.get(signature) ?? [];
      bucket.push(line);
      bySignature.set(signature, bucket);
      if (old) {
        diff.reused += 1;
        if (old.status === 'alive') diff.reusedAlive += 1;
        else if (old.status === 'suspect') diff.reusedQuarantine += 1;
        else if (!old.lastProbeAt) diff.reusedPending += 1;
        else diff.reusedOther += 1;
      } else {
        diff.added += 1;
      }
    }
  }

  // Sources that returned 304 / failed keep their previous lines instead of
  // being wiped — a bad upstream day must not destroy the catalog.
  for (const old of previousLines) {
    if (authoritative.has(old.sourceId)) continue;
    if (!sources.has(old.sourceId)) continue;
    if (tombstoned.has(canonicalPoolUrl(old.url))) continue;
    const key = `${old.sourceId}|${old.urlKey}`;
    if (removed.has(key)) continue;
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
    if (removed.has(key)) continue;
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

  const afterBySource = countLineStatuses([...merged.values()]);
  for (const diff of report.values()) {
    diff.after = afterBySource.get(diff.sourceId) ?? emptyStatusCounts();
  }
  return { lines: [...merged.values()], authoritative, report: [...report.values()] };
}

async function collectSourceWithRetry(source: SourceRecord, store: ArtifactStore, logger: RunLogger): Promise<CollectedSource> {
  // Retries live in the shared fetch layer (fetchText) so they respect the
  // error classification: 4xx/challenge fail fast, 5xx/timeout/network retry.
  // A whole-source cap keeps one wedged stream (or parser) from parking the
  // task for half an hour while the UI looks frozen.
  const limitMs = Math.max(120_000, Number(source.fetch_timeout_ms ?? 45_000) * 2);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      collectSource(source, store, logger),
      new Promise<CollectedSource>((resolve) => {
        timer = setTimeout(() => {
          logger.warn('抓取超时', { source: source.name, limitMs });
          resolve({
            source,
            entries: [],
            fetched: false,
            notModified: false,
            bytes: 0,
            error: `#1 源处理超过 ${Math.round(limitMs / 1000)} 秒，已放弃`,
            errorKind: 'timeout',
          });
        }, limitMs);
      }),
    ]);
  } catch (error) {
    logger.warn('抓取异常', { source: source.name, error: error instanceof Error ? error.message : String(error) });
    return { source, entries: [], fetched: false, notModified: false, bytes: 0, error: '抓取失败', errorKind: 'network' };
  } finally {
    if (timer) clearTimeout(timer);
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
  onStart?: (source: SourceRecord, done: number, total: number) => void,
): Promise<CollectedSource[]> {
  let done = 0;
  return mapPool(sources, 4, async (source) => {
    onStart?.(source, done, sources.length);
    try {
      return await collectSourceWithRetry(source, store, logger);
    } finally {
      done++;
      onProgress?.(done, sources.length, source.name);
    }
  });
}

async function writeLog(store: ArtifactStore, runId: string, logger: RunLogger): Promise<string> {
  // A run log is diagnostic only: an upload failure must never fail the task
  // itself (e.g. a transient 500 from the artifact endpoint).
  try {
    const day = new Date().toISOString().slice(0, 10);
    const key = `logs/${day}/${runId}.jsonl`;
    await store.put(key, logger.toJSONL(), 'application/x-ndjson; charset=utf-8');
    return key;
  } catch (error) {
    logger.warn('运行日志上传失败（已忽略，不影响任务结果）', { error: error instanceof Error ? error.message : String(error) });
    return '';
  }
}

async function finishRun(
  api: ApiClient,
  report: RunReport,
): Promise<void> {
  const message = report.message ?? (lastProgressMessage || undefined);
  await api.post('/api/admin/runs', { ...report, message, taskId: report.taskId ?? process.env.TASK_ID ?? undefined }).catch((error) => {
    console.error(redactError('上报运行结果失败', error));
  });
}

/** URLs the operator has permanently retired; they must never be re-imported. */
async function loadTombstones(api: ApiClient): Promise<Set<string>> {
  try {
    const response = await api.get<{ urls?: string[] }>('/api/admin/pool/tombstones');
    return new Set((response.urls ?? []).map((url) => canonicalPoolUrl(url)));
  } catch (error) {
    console.error(redactError('读取墓碑失败，本轮不跳过任何线路', error));
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
    const previousState = await loadLinesState(store);
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
  const mergedGroups = mergedGroupMap(remote);
  return buildPoolSnapshot({
    lines,
    channels: registry.list().map((seed) => ({ id: seed.id, name: seed.name, group: poolChannelGroup(seed.id, seed.group, mergedGroups), tvgId: seed.tvgId, logo: seed.logo })),
    maxLinesPerChannel: remote.settings.maxLinesPerChannel,
    generatedAt,
  });
}

/** Merged channels (`x-mc-…`) must use the user-configured group, not the line group. */
function mergedGroupMap(remote: RemoteConfig): Map<string, string> {
  const groups = new Map<string, string>();
  for (const source of remote.sources) {
    if (!source.mergeChannelName) continue;
    groups.set(mergedChannelId(source.id), source.mergeChannelGroup || '影视');
  }
  return groups;
}

function poolChannelGroup(id: string, fallback: string, mergedGroups: Map<string, string>): string {
  return isMergedChannelId(id) ? (mergedGroups.get(id) ?? fallback) : fallback;
}

const LIVENESS_RETRY_MS = 6 * 3_600_000;
const UNPROBEABLE_URL = /^(rtsp|rtmp|rtmps|udp|rtp):\/\//i;

function pruneOrphanLines(remote: RemoteConfig, lines: LineEntry[]): { lines: LineEntry[]; removed: number } {
  const channelIds = new Set(remote.channels.map((channel) => channel.id));
  // Keep lines for brand-new channels (`x-…` ids created from source names):
  // dropping them here means a source that only carries new channels can never
  // publish one. Once the channel is published it is in `remote.channels`.
  const kept = lines.filter((line) => channelIds.has(line.channelId) || line.channelId.startsWith('x-'));
  return { lines: kept, removed: lines.length - kept.length };
}

function livenessReady(line: LineEntry, now: number): boolean {
  if (!line.lastLivenessAt) return true;
  return now - Date.parse(line.lastLivenessAt) >= LIVENESS_RETRY_MS;
}

/** Small summary consumed by the Worker scheduler; avoids parsing lines.json. */
function poolStatsFor(remote: RemoteConfig, lines: LineEntry[], generatedAt = new Date().toISOString()) {
  const channelIds = new Set(remote.channels.map((channel) => channel.id));
  const valid = lines.filter((line) => channelIds.has(line.channelId) && !UNPROBEABLE_URL.test(line.url));
  const now = Date.now();
  const nowDate = new Date(now);
  return {
    generatedAt,
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

async function writePoolStats(store: ArtifactStore, remote: RemoteConfig, lines: LineEntry[], generatedAt?: string): Promise<void> {
  await store.put('state/pool-stats.json', JSON.stringify(poolStatsFor(remote, lines, generatedAt)), 'application/json');
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

  const collected = await collectAll(
    targetSources,
    store,
    logger,
    (done, total, label) => {
      void reportTaskProgress(api, done, total, label ? `抓取完成 ${label}（${done}/${total}）` : `抓取采集站（${done}/${total}）`);
    },
    (source, done, total) => {
      void reportTaskProgress(api, done, total, `抓取中 · ${source.name}（已完成 ${done}/${total}）`, true);
    },
  );
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
  // Half the catalog is cross-source duplicates: probe each unique URL once and
  // share the result with its siblings instead of spending budget twice.
  const targets = dedupeProbeTargets(planned);
  logger.info('测速计划', {
    due: allDue.length,
    budget,
    capped: allDue.length > budget,
    planned: planned.length,
    uniqueUrls: targets.length,
    force,
    premium: premium.size,
    sourceId: sourceId || undefined,
  });

  const aliveBefore = probeCandidates.filter((line) => line.status === 'alive').length;
  const summary = await runProbes(targets, settings, config.concurrency || settings.concurrency, logger);
  const freshTargets = targets.filter((line) => line.lastProbeAt && Date.now() - Date.parse(line.lastProbeAt) < 10 * 60_000);
  const fannedOut = fanoutProbeResults(lines, freshTargets);
  if (fannedOut) logger.info('URL 去重同步', { fannedOut });
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
  const storedGuide = await store.getJson<StoredGuide>('state/guide.json');
  const epg = epgMode === 'fetch'
    ? await collectEpg(settings.epgUrls, registry, logger, parseEpgPriority(settings.epgSourcePriority))
    : { xml: null, programmes: 0, data: epgFromGuide(storedGuide) };
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
  // Guide mode must not rebuild the stored guide: buildGuide drops programmes
  // that already ended, so repeated publishes would erode the schedule and,
  // worse, rewrite generatedAt and keep looking "fresh" without ever fetching.
  if (storedGuide?.channels && Object.keys(storedGuide.channels).length) {
    const before = Object.keys(storedGuide.channels).length;
    const after = Object.keys(output.guide.channels).length;
    if (epgMode === 'guide' || after < before / 2) {
      if (epgMode === 'fetch' && after < before / 2) {
        logger.warn('EPG 抓取结果明显变小，保留上一版指南', { before, after });
      }
      output.guide = {
        generatedAt: storedGuide.generatedAt ?? output.guide.generatedAt,
        hours: storedGuide.hours ?? output.guide.hours,
        channels: storedGuide.channels,
      };
    }
  }
  await reportTaskProgress(api, 2, 5, '频道聚合完成');
  // Publish used to rebuild only the catalogs, leaving state/pool.json and
  // pool-stats at the last fetch/probe timestamp. Refresh both here so every
  // publish also refreshes the pool overview the public page reads.
  // Reuse the catalog timestamp: the dashboard warns when pool-stats is newer
  // than the index, and writing a fresh `now` here made that warning fire after
  // every single publish.
  const poolGeneratedAt = output.catalog.generatedAt;
  await store.put('state/pool.json', JSON.stringify(poolSnapshotFor(remote, lines, poolGeneratedAt)), 'application/json');
  await writePoolStats(store, remote, lines, poolGeneratedAt);
  const logKey = await writeLog(store, runId, logger);
  const poolSnapshot = buildPoolSnapshot({
    lines,
    channels: registry.list().map((seed) => ({ id: seed.id, name: seed.name, group: poolChannelGroup(seed.id, seed.group, mergedGroupMap(remote)), tvgId: seed.tvgId, logo: seed.logo })),
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
    const previousState = await loadLinesState(store);
    report.sources = remote.sources.length;
    const { lines, collected, sourceId } = await fetchPhase(api, remote, store, logger, previousState, tombstones);
    await saveLinesState(store, lines, nowIso());
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
    const previousState = await loadLinesState(store);
    const lines = previousState?.lines ?? [];
    if (!lines.length) throw new Error('没有线路状态，请先运行 fetch');
    report.sources = remote.sources.length;
    const sourceId = (process.env.SOURCE_ID ?? '').trim();
    const { summary } = await probePhase(lines, remote, config, logger, sourceId, false);

    const generatedAt = nowIso();
    await saveLinesState(store, lines, generatedAt);
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
const PREFILTER_COOLDOWN_KEY = 'state/prefilter-cooldown.json';
const PREFILTER_COOLDOWN_MS = 24 * 3_600_000;

/** Signatures blocked by the liveness prefilter recently; probing them again within 24h wastes a slot. */
async function loadPrefilterCooldown(store: ArtifactStore): Promise<Map<string, number>> {
  const raw = await store.getJson<Record<string, string>>(PREFILTER_COOLDOWN_KEY).catch(() => null);
  const map = new Map<string, number>();
  const now = Date.now();
  for (const [signature, at] of Object.entries(raw ?? {})) {
    const until = Date.parse(at);
    if (Number.isFinite(until) && until > now) map.set(signature, until);
  }
  return map;
}

async function savePrefilterCooldown(store: ArtifactStore, cooldown: Map<string, number>): Promise<void> {
  const now = Date.now();
  const entries = [...cooldown.entries()]
    .filter(([, until]) => until > now)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20_000);
  const out: Record<string, string> = {};
  for (const [signature, until] of entries) out[signature] = new Date(until).toISOString();
  await store.put(PREFILTER_COOLDOWN_KEY, JSON.stringify(out), 'application/json');
}

async function runProxyTest(): Promise<void> {
  const config = loadConfig();
  const logger = new RunLogger();
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = nowIso();
  const startedMs = Date.now();
  const api = new ApiClient(config.apiBaseUrl, config.adminToken);
  try {
    const remote = await loadRemoteConfig(api);
    const { items } = await api.get<{
      items: Array<{ id: string; name: string; protocol: string; host: string; port: number; username: string; password?: string; enabled: boolean; kernelOnly: boolean; config?: string; engine?: string; subscriptionId?: string; lastOkAt?: string | null; lastLatencyMs?: number | null }>;
    }>('/api/admin/proxies?secrets=1');
    const only = (process.env.PROXY_ID ?? '').trim();
    const onlySubscription = (process.env.PROXY_SUB_ID ?? '').trim();
    const nodes = items.filter((node) => node.enabled
      && (!only || node.id === only)
      && (!onlySubscription || node.subscriptionId === onlySubscription));
    const udpNodes = nodes.filter((node) => isUdpOnlyProxy(node));
    const testable = nodes.filter((node) => !isUdpOnlyProxy(node));
    if (!testable.length) {
      throw new Error(udpNodes.length
        ? `该订阅只有 UDP 节点（hy2/tuic，${udpNodes.length} 个），当前环境不可测`
        : (onlySubscription ? '该订阅没有可测活的节点（需启用）' : '没有可测活的代理（需启用）'));
    }
    const concurrency = Math.max(1, Math.min(10, Number(remote.settings.cnProbeConcurrency) || 5));
    // Domestic HTTP/SOCKS endpoints already proven alive; kernel nodes chain
    // through them because some servers reject datacenter egress.
    const hops = items
      .filter((node) => node.enabled && !node.kernelOnly && !isUdpOnlyProxy(node) && node.lastOkAt && (node.protocol === 'http' || node.protocol === 'socks5'))
      .sort((a, b) => (a.lastLatencyMs ?? Number.MAX_SAFE_INTEGER) - (b.lastLatencyMs ?? Number.MAX_SAFE_INTEGER))
      .slice(0, 3)
      .map((node) => ({
        protocol: node.protocol === 'socks5' ? ('socks5' as const) : ('http' as const),
        host: node.host,
        port: node.port,
        username: node.username || undefined,
        password: node.password || undefined,
      }));
    const total = testable.length;
    const queue = [...testable];
    let skippedUdp = udpNodes.length;
    let done = 0;
    let ok = 0;
    let kernelOk = 0;
    logger.info('开始代理测活', { total, concurrency, skippedUdp });
    await reportTaskProgress(api, 0, total, `代理测活 0/${total}${skippedUdp ? ` · 跳过 UDP ${skippedUdp}` : ''}`, true);
    const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
      for (;;) {
        const node = queue.shift();
        if (!node) return;
        const result = await probeRuntimeProxy(node, isKernelProxy(node) ? { hops } : {});
        if (result.ok) {
          ok += 1;
          if (isKernelProxy(node)) kernelOk += 1;
        }
        await api.post(`/api/admin/proxies/${node.id}/check`, result).catch((error) => {
          logger.warn('写入测活结果失败', { proxy: node.name, error: error instanceof Error ? error.message : String(error) });
        });
        done += 1;
        await reportTaskProgress(api, done, total, `代理测活 ${done}/${total} · 成功 ${ok}${kernelOk ? ` · 内核 ${kernelOk}` : ''}${skippedUdp ? ` · 跳过 UDP ${skippedUdp}` : ''}`, true);
      }
    });
    await Promise.all(workers);
    await finishRun(api, {
      id: runId, trigger: 'manual', status: 'success', startedAt, finishedAt: nowIso(),
      sources: 0, channels: 0, lines: 0, alive: ok, dead: total - ok, probed: total, bytes: 0,
      durationMs: Date.now() - startedMs,
      warnings: skippedUdp ? [`跳过 ${skippedUdp} 个 UDP 节点（hy2/tuic，当前环境不可测）`] : [],
    });
    logger.info('代理测活完成', { total, ok });
  } catch (error) {
    await finishRun(api, {
      id: runId, trigger: 'manual', status: 'failed', startedAt, finishedAt: nowIso(),
      sources: 0, channels: 0, lines: 0, alive: 0, dead: 0, probed: 0, bytes: 0,
      durationMs: Date.now() - startedMs, warnings: [], error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    throw error;
  }
}

async function runProxyFetchSub(): Promise<void> {
  const config = loadConfig();
  const logger = new RunLogger();
  const api = new ApiClient(config.apiBaseUrl, config.adminToken);
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = nowIso();
  const startedMs = Date.now();
  const url = (process.env.SUB_URL ?? '').trim();
  const userAgent = (process.env.USER_AGENT ?? '').trim();
  const proxyId = (process.env.PROXY_ID ?? '').trim();
  const subId = (process.env.SUB_ID ?? '').trim();
  const mode = (process.env.FETCH_MODE ?? 'proxy').trim() === 'actions' ? 'actions' : 'proxy';
  try {
    if (!/^https?:\/\//i.test(url)) throw new Error('缺少订阅地址');
    let text = '';
    let used = '';
    if (mode === 'actions') {
      await reportTaskProgress(api, 0, 1, 'Actions 直连拉取订阅', true);
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { 'user-agent': userAgent || 'clash-verge/v1.0', accept: '*/*' },
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        throw new Error(`请求失败：${error instanceof Error ? error.message : String(error)}`);
      }
      if (!response.ok) throw new Error(`订阅返回 HTTP ${response.status}`);
      text = await response.text();
      if (!text.trim()) throw new Error('订阅内容为空');
      used = 'Actions 出口';
    } else {
      const { items } = await api.get<{
        items: Array<{ id: string; name: string; protocol: string; host: string; port: number; username: string; password?: string; enabled: boolean; kernelOnly: boolean; config?: string; engine?: string; lastOkAt: string | null }>;
      }>('/api/admin/proxies?secrets=1');
      // Plain proxies are fast to try; kernel nodes start mihomo, so keep them last.
      const plain = items
        .filter((node) => node.enabled && !node.kernelOnly && (!proxyId || node.id === proxyId))
        .sort((a, b) => (b.lastOkAt ?? '').localeCompare(a.lastOkAt ?? ''));
      const kernel = items
        .filter((node) => node.enabled && node.kernelOnly && (!proxyId || node.id === proxyId))
        .sort((a, b) => (b.lastOkAt ?? '').localeCompare(a.lastOkAt ?? ''));
      const candidates = [...plain, ...kernel];
      if (!candidates.length) throw new Error('没有可用代理，请先测活至少一个');
      await reportTaskProgress(api, 0, 1, `代理拉取订阅 · 预检 ${candidates[0].name}`, true);
      let lastError = '';
      for (const node of candidates.slice(0, 6)) {
        const probe = await probeRuntimeProxy(node);
        await api.post(`/api/admin/proxies/${node.id}/check`, probe).catch(() => undefined);
        if (!probe.ok) {
          lastError = `${node.name}: ${probe.error}`;
          continue;
        }
        let active: Awaited<ReturnType<typeof activateRuntimeProxy>> | null = null;
        try {
          active = await activateRuntimeProxy(node);
          const response = await fetchViaProxy(url, active.proxy, { userAgent, timeoutMs: 30_000 });
          text = response.body;
          used = `${node.name}${active.kernelOnly ? '（内核）' : ''}（出口 ${probe.egressIp || '未知'}）`;
          break;
        } catch (error) {
          lastError = `${node.name}: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
          await active?.stop();
        }
      }
      if (!text.trim()) throw new Error(`没有代理能拉取订阅：${lastError}`);
    }
    await reportTaskProgress(api, 0, 1, `${used} · 已获取内容，正在导入`, true);
    const result = await api.post<{ added: number; updated?: number; disabled?: number; skipped: number; kernelOnly: number }>('/api/admin/proxies/import', { text, userAgent, subscriptionId: subId || undefined });
    logger.info('订阅拉取完成', { used, added: result.added, updated: result.updated ?? 0, disabled: result.disabled ?? 0, skipped: result.skipped });
    const extra = result.updated || result.disabled ? ` · 更新 ${result.updated ?? 0} · 停用 ${result.disabled ?? 0}` : '';
    await reportTaskProgress(api, 1, 1, `订阅拉取完成 · ${used} · 新增 ${result.added}${extra} · 跳过 ${result.skipped}`, true);
    await finishRun(api, {
      id: runId, trigger: 'manual', status: 'success', startedAt, finishedAt: nowIso(),
      sources: 0, channels: 0, lines: 0, alive: result.added, dead: result.skipped, probed: result.added + result.skipped, bytes: text.length,
      durationMs: Date.now() - startedMs, warnings: [],
    });
  } catch (error) {
    logger.error('代理拉取订阅失败', { error: error instanceof Error ? error.message : String(error) });
    await finishRun(api, {
      id: runId, trigger: 'manual', status: 'failed', startedAt, finishedAt: nowIso(),
      sources: 0, channels: 0, lines: 0, alive: 0, dead: 0, probed: 0, bytes: 0,
      durationMs: Date.now() - startedMs, warnings: [error instanceof Error ? error.message : String(error)],
    }).catch(() => undefined);
    throw error;
  }
}

async function runCnProbe(): Promise<void> {
  const config = loadConfig();
  const logger = new RunLogger();
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = nowIso();
  const startedMs = Date.now();
  const api = new ApiClient(config.apiBaseUrl, config.adminToken);
  const store = new ArtifactStore(api);
  try {
    const remote = await loadRemoteConfig(api);
    const settings = remote.settings;
    const sourceNames = new Map(remote.sources.map((source) => [source.id, source.name]));
    const { items } = await api.get<{
      items: Array<{ id: string; name: string; protocol: string; host: string; port: number; username: string; password?: string; enabled: boolean; kernelOnly: boolean; config?: string; engine?: string }>;
    }>('/api/admin/proxies?secrets=1');
    const usable = items.filter((node) => node.enabled);
    if (!usable.length) throw new Error('没有启用的国内代理，无法补测');
    // Plain proxies are cheap to precheck; kernel nodes start mihomo, so try them last.
    const ordered = [...usable].sort((left, right) => Number(isKernelProxy(left)) - Number(isKernelProxy(right)));
    let chosen: (typeof usable)[number] | null = null;
    for (const node of ordered) {
      const result = await probeRuntimeProxy(node);
      await api.post(`/api/admin/proxies/${node.id}/check`, result).catch(() => undefined);
      if (result.ok) {
        chosen = node;
        break;
      }
    }
    if (!chosen) throw new Error('所有国内代理都不可用，补测中止');
    const active = await activateRuntimeProxy(chosen);
    try {
      logger.info('补测代理已选定', { proxy: chosen.name, kernel: active.kernelOnly });
      const agent = buildProxyAgent(active.proxy);
    const previous = await loadLinesState(store);
    const lines = previous?.lines ?? [];
    const now = Date.now();
    const seen = new Set<string>();
    const candidates = lines
      .filter(
        (line) =>
          (line.status === 'dead' || line.status === 'suspect') &&
          line.cnReachable !== true &&
          (!line.cnCheckedAt || now - Date.parse(line.cnCheckedAt) > 24 * 3_600_000),
      )
      // Fresh breakage first: a dead line that just failed is likelier to be a
      // domestic-only stream than one that has been stale for weeks.
      .sort((left, right) => {
        if (left.status !== right.status) return left.status === 'dead' ? -1 : 1;
        return (Date.parse(right.lastProbeAt ?? '2020-01-01') || 0) - (Date.parse(left.lastProbeAt ?? '2020-01-01') || 0);
      })
      // The same URL + headers is one playback target; retrying every source copy
      // only burns the domestic proxy without extra information.
      .filter((line) => {
        const signature = lineSignature(line);
        if (seen.has(signature)) return false;
        seen.add(signature);
        return true;
      });
    const limit = Math.max(1, Math.min(1000, Number(settings.cnProbeBatchSize) || 200));
    const selected = candidates.slice(0, limit);
    if (!selected.length) {
      await reportTaskProgress(api, 0, 0, '国内补测完成 · 没有需要补测的线路', true);
      await finishRun(api, {
        id: runId, trigger: 'manual', status: 'success', startedAt, finishedAt: nowIso(),
        sources: 0, channels: 0, lines: 0, alive: 0, dead: 0, probed: 0, bytes: 0,
        durationMs: Date.now() - startedMs, warnings: [],
      });
      return;
    }
    const concurrency = Math.max(1, Math.min(10, Number(settings.cnProbeConcurrency) || 5));
    const bySource = new Map<string, { tested: number; ok: number }>();
    const queue = [...selected];
    let done = 0;
    let ok = 0;
    await reportTaskProgress(api, 0, selected.length, `国内补测 0/${selected.length}`, true);
    const workers = Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
      for (;;) {
        const line = queue.shift();
        if (!line) return;
        const stat = bySource.get(line.sourceId) ?? { tested: 0, ok: 0 };
        stat.tested += 1;
        bySource.set(line.sourceId, stat);
        const result = await probeCnUrl(line.url, agent);
        line.cnCheckedAt = nowIso();
        if (result.ok) {
          ok += 1;
          stat.ok += 1;
          line.status = 'alive';
          line.cnReachable = true;
          line.cnProxyId = chosen!.id;
          line.cnLatencyMs = result.latencyMs;
          line.speedKbps = result.speedKbps;
          line.failCount = 0;
          line.lastProbeAt = line.cnCheckedAt;
        } else {
          line.cnReachable = false;
        }
        done += 1;
        await reportTaskProgress(api, done, selected.length, `国内补测 ${done}/${selected.length} · 成功 ${ok}`, true);
      }
    });
    await Promise.all(workers);
    const sourceSummary = [...bySource.entries()]
      .sort((left, right) => right[1].tested - left[1].tested)
      .slice(0, 5)
      .map(([id, stat]) => `${sourceNames.get(id) ?? id} 测${stat.tested}/成功${stat.ok}`)
      .join('、');
    await reportTaskProgress(
      api,
      selected.length,
      selected.length,
      `国内补测完成 · ${selected.length} 条 · 成功 ${ok}${active.kernelOnly ? ' · 内核' : ''}${sourceSummary ? ` · 来源：${sourceSummary}` : ''}`,
      true,
    );
    await saveLinesState(store, lines, nowIso());
    await finishRun(api, {
      id: runId, trigger: 'manual', status: 'success', startedAt, finishedAt: nowIso(),
      sources: bySource.size, channels: 0, lines: selected.length, alive: ok, dead: 0, probed: selected.length, bytes: 0,
      durationMs: Date.now() - startedMs, warnings: [],
    });
    logger.info('国内补测完成', { tested: selected.length, ok, proxy: chosen.name, kernel: active.kernelOnly });
    } finally {
      await active.stop();
    }
  } catch (error) {
    await finishRun(api, {
      id: runId, trigger: 'manual', status: 'failed', startedAt, finishedAt: nowIso(),
      sources: 0, channels: 0, lines: 0, alive: 0, dead: 0, probed: 0, bytes: 0,
      durationMs: Date.now() - startedMs, warnings: [], error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    throw error;
  }
}

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
    const previous = await loadLinesState(store);
    const lines = previous?.lines ?? [];
    if (!lines.length) throw new Error('没有线路状态，请先运行 fetch');
    const channelIds = new Set(remote.channels.map((channel) => channel.id));
    const poolChannels = new Set(lines.map((line) => line.channelId)).size;
    const now = Date.now();
    const forcedPhase = (process.env.PROBE_PHASE ?? '').trim() as 'pending' | 'quarantine' | '';
    const paused = new Set(parsePhaseList(settings.probePausedPhases));
    const batchSize = activeProbeProfile(settings).batchSize;
    const perChannel = Math.max(1, Number(settings.probePerChannel) || 24);
    const cooldown = await loadPrefilterCooldown(store);
    const favoriteSources = new Set(remote.sources.filter((source) => source.weight >= 2).map((source) => source.id));
    const selectedSignatures = new Set<string>();
    const selected: LineEntry[] = [];
    const chosenByPhase = { pending: 0, quarantine: 0 };

    // One representative line per URL signature: the batch budget is spent on
    // distinct streams, not on duplicates of the same URL. Channels are visited
    // round-robin so a single merged channel cannot starve the rest.
    const pickPhase = (phase: 'pending' | 'quarantine', limit: number): void => {
      const picked = selectProbeLines(lines, {
        matches: (line) => phaseMatches(line, phase, now, forcedPhase === phase),
        channelIds,
        favorites: favoriteSources,
        cooldown,
        takenSignatures: selectedSignatures,
        now,
        perChannel,
        mergedPerChannel: MERGED_PROBE_PER_CHANNEL,
        limit,
      });
      for (const line of picked) {
        selected.push(line);
        chosenByPhase[phase] += 1;
      }
    };

    // 70% of the batch goes to never-probed lines, the rest to lines that failed
    // before; a phase that is paused or empty hands its slots to the other one.
    if (forcedPhase && ['pending', 'quarantine'].includes(forcedPhase)) {
      pickPhase(forcedPhase, batchSize);
    } else {
      // Pending first: a full batch should spend its quota on unknown streams.
      // Suspect lines only fill the leftover when pending runs dry.
      if (!paused.has('pending')) pickPhase('pending', batchSize);
      const quarantineTarget = batchSize - selected.length;
      if (!paused.has('quarantine') && quarantineTarget > 0) pickPhase('quarantine', quarantineTarget);
    }

    if (!selected.length) {
      logger.info('分批探测空闲：没有待测线路');
      await writePoolStats(store, remote, lines);
      await syncSourceCounts(api, remote, lines);
      report = { ...report, status: 'success', finishedAt: nowIso(), channels: poolChannels, lines: lines.length, durationMs: Date.now() - startedMs };
      await finishRun(api, report);
      return;
    }
    const phaseLabel = `待测 ${chosenByPhase.pending} · 疑似 ${chosenByPhase.quarantine}`;
    logger.info('分批探测计划', { phases: chosenByPhase, batch: selected.length, batchSize, forced: Boolean(forcedPhase) });

    const blocked = await prefilterLiveness(selected, settings, config.concurrency || settings.concurrency || 32, logger);
    if (blocked.size) {
      const nextCooldown = new Map(cooldown);
      const until = now + PREFILTER_COOLDOWN_MS;
      for (const line of selected) {
        if (blocked.has(line.key)) nextCooldown.set(lineSignature(line), until);
      }
      // 冷却文件只影响下一批要不要重复探测，属于辅助数据；网络抖动时不能
      // 因此把整批任务判失败（否则会白白触发一次自动重试）。
      try {
        await savePrefilterCooldown(store, nextCooldown);
      } catch (error) {
        logger.warn('预筛冷却文件上传失败，已跳过', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    const probeList = selected.filter((line) => !blocked.has(line.key));
    const targets = dedupeProbeTargets(probeList);
    await reportTaskProgress(api, 0, targets.length, `分批探测 · ${phaseLabel} · 选中 ${selected.length} 条 · 预筛拦截 ${blocked.size} 条 · 去重后 ${targets.length} 个地址`);
    const summary = await runProbes(targets, settings, config.concurrency || settings.concurrency, logger, (done) => {
      void reportTaskProgress(api, done, targets.length, `分批探测 · ${phaseLabel} · ${done}/${targets.length}`);
    });
    const freshTargets = targets.filter((line) => line.lastProbeAt && Date.now() - Date.parse(line.lastProbeAt) < 10 * 60_000);
    const fannedOut = fanoutProbeResults(lines, freshTargets);
    const ffprobeLimit = Math.max(0, envNumber('FFPROBE_LIMIT') ?? settings.ffprobeLimit ?? 150);
    if (ffprobeLimit > 0) await enrichResolutions(probeList, ffprobeLimit, logger);
    const sourceNames = new Map(remote.sources.map((source) => [source.id, source.name]));
    const bySource = new Map<string, { tested: number; alive: number }>();
    for (const line of targets) {
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
    await reportTaskProgress(api, selected.length, selected.length, `分批探测完成 · ${phaseLabel} · 选中 ${selected.length} 条 · 预筛拦截 ${blocked.size} 条 · 去重后 ${targets.length} 个地址 · 可用 ${summary.alive} · 同步 ${fannedOut} 条${sourceSuffix}`);
    logger.info('分批探测完成', { phases: chosenByPhase, checked: selected.length, probed: summary.probed, alive: summary.alive, dead: summary.dead });

    const generatedAt = nowIso();
    await saveLinesState(store, lines, generatedAt);
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
    const previousState = await loadLinesState(store);
    const lines = previousState?.lines ?? [];
    if (!lines.length) throw new Error('没有线路状态，请先运行 fetch/probe');
    report.sources = remote.sources.length;
    // The daily `epg` task is the primary refresher, but the scheduler can skip
    // a slot; a stale or empty guide would blank every player's programme list.
    const storedGuide = await store.getJson<StoredGuide>('state/guide.json');
    const mode = guideIsFresh(storedGuide) ? 'guide' : 'fetch';
    const { output, logKey } = await publishPhase(api, store, config, remote, lines, logger, runId, mode);
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
    const previousState = await loadLinesState(store);
    report.sources = remote.sources.length;
    logger.info('配置加载完成', { sources: remote.sources.length, channels: remote.channels.length, rules: remote.rules.length });

    const { lines, collected, sourceId } = await fetchPhase(api, remote, store, logger, previousState, tombstones);
    const { summary } = await probePhase(lines, remote, config, logger, sourceId, true);
    const { output, logKey } = await publishPhase(api, store, config, remote, lines, logger, runId, 'fetch');
    // Record fetch metadata only after a successful publish: syncing before it
    // advanced etags/last_fetch_at even when the publish failed, so the next run
    // got a 304 (or skipped on the interval) and lost the whole batch.
    await syncSourceStats(api, remote, lines, collected, sourceId);

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
    const previous = await loadLinesState(store);
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

    const aliveBefore = lines.filter((line) => line.status === 'alive').length;
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

    const aliveAfter = lines.filter((line) => line.status === 'alive').length;
    if (aliveBefore >= 50 && aliveAfter < aliveBefore * 0.5) {
      // A runner-side network outage used to demote almost the whole pool and
      // then overwrite pool.json with the demoted state, taking subscriptions
      // down. Fail the run instead of persisting the collapse.
      throw new Error(`轻量测活后可用线路从 ${aliveBefore} 降到 ${aliveAfter}（低于 50%），疑似出口网络异常，已放弃写入`);
    }

    const generatedAt = nowIso();
    await saveLinesState(store, lines, generatedAt);
    const poolSnapshot = buildPoolSnapshot({
      lines,
      channels: remote.channels.map((channel) => ({ id: channel.id, name: channel.name, group: poolChannelGroup(channel.id, channel.group_title ?? '其他', mergedGroupMap(remote)), tvgId: channel.tvg_id, logo: channel.logo })),
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

async function reportTaskProgress(api: ApiClient, done: number, total: number, message?: string, force = false): Promise<void> {
  const messageChanged = Boolean(message) && message !== lastProgressMessage;
  if (message) lastProgressMessage = message;
  const taskId = process.env.TASK_ID;
  if (!taskId) return;
  const now = Date.now();
  const final = total > 0 && done >= total;
  if (!final && !force && !messageChanged && now - lastProgressAt < 10_000 && done - lastProgressDone < 50) return;
  lastProgressAt = now;
  lastProgressDone = done;
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
    const previous = await loadLinesState(store);
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
    await saveLinesState(store, lines, generatedAt);
    const poolSnapshot = buildPoolSnapshot({
      lines,
      channels: remote.channels.map((channel) => ({ id: channel.id, name: channel.name, group: poolChannelGroup(channel.id, channel.group_title ?? '其他', mergedGroupMap(remote)), tvgId: channel.tvg_id, logo: channel.logo })),
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
    const previous = await loadLinesState(store);
    const pruned = pruneOrphanLines(remote, previous?.lines ?? []);
    const lines = pruned.lines;
    const generatedAt = nowIso();
    await saveLinesState(store, lines, generatedAt);
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
    const previous = await loadLinesState(store);
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
    const removed = new Set(expired.map((line) => line.key));
    const kept = lines.filter((line) => !removed.has(line.key));
    const generatedAt = nowIso();
    // Save the surviving lines first: tombstones written before the save made
    // the URLs permanently unimportable even when the save then failed.
    await saveLinesState(store, kept, generatedAt);
    await api.post('/api/admin/pool/tombstone', { urls: [...new Set(expired.map((line) => line.url))], reason: 'retention' });
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
    const previous = await loadLinesState(store);
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
    await saveLinesState(store, lines, generatedAt);
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

/** A4：线路级规则预览——读已发布线路，按当前规则统计每条规则的真实影响。 */
async function runRulesPreview(): Promise<void> {
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
    const state = await loadLinesState(store);
    const lines = state?.lines ?? [];
    const compiled = compileRules(remote.rules);
    const byChannel = new Map<string, LineEntry[]>();
    for (const line of lines) {
      const list = byChannel.get(line.channelId) ?? [];
      list.push(line);
      byChannel.set(line.channelId, list);
    }

    const stats = new Map<string, { id: string; note: string; matched: number; excluded: number; channels: Set<string>; samples: string[] }>();
    for (const rule of remote.rules) {
      if (!rule.enabled) continue;
      stats.set(rule.id, {
        id: rule.id,
        note: rule.actions?.rename ?? rule.actions?.setGroup ?? rule.match?.channelPattern ?? rule.match?.namePattern ?? '',
        matched: 0,
        excluded: 0,
        channels: new Set<string>(),
        samples: [],
      });
    }

    let changedChannels = 0;
    let changedLines = 0;
    let excludedLines = 0;
    for (const channel of remote.channels) {
      const channelLines = byChannel.get(channel.id) ?? [];
      if (!channelLines.length) continue;
      const base = { id: channel.id, name: channel.name, group: channel.group_title ?? '其他', tvgId: channel.tvg_id } as ChannelConfig;
      const applied = applyRules(base, channelLines, compiled);
      if (applied.channel.name !== base.name || applied.channel.group !== base.group) {
        changedChannels++;
        changedLines += applied.lines.length;
      }
      excludedLines += channelLines.length - applied.lines.length;

      for (const compiledRule of compiled) {
        let matched = 0;
        let excluded = 0;
        for (const line of channelLines) {
          if (!compiledRule.matches({ channel: base, line })) continue;
          matched++;
          if (compiledRule.rule.actions?.exclude) excluded++;
        }
        if (!matched) continue;
        const stat = stats.get(compiledRule.rule.id);
        if (!stat) continue;
        stat.matched += matched;
        stat.excluded += excluded;
        stat.channels.add(channel.id);
        if (stat.samples.length < 5) stat.samples.push(`${base.name} / ${channelLines[0]?.name ?? ''}`);
      }
    }

    const payload = {
      generatedAt: nowIso(),
      totalChannels: remote.channels.length,
      totalLines: lines.length,
      changedChannels,
      changedLines,
      excludedLines,
      rules: [...stats.values()].map((stat) => ({
        id: stat.id,
        note: stat.note,
        matchedLines: stat.matched,
        excludedLines: stat.excluded,
        affectedChannels: stat.channels.size,
        samples: stat.samples,
      })),
    };
    await store.put('state/rules-preview.json', JSON.stringify(payload), 'application/json; charset=utf-8');
    const logKey = await writeLog(store, runId, logger);
    report = {
      ...report,
      status: 'success',
      finishedAt: nowIso(),
      channels: remote.channels.length,
      lines: lines.length,
      alive: lines.filter((line) => line.status === 'alive').length,
      durationMs: Date.now() - startedMs,
      logKey,
      message: `规则预览：命中 ${payload.rules.length} 条规则，影响 ${changedChannels} 个频道 / ${changedLines} 条线路，排除 ${excludedLines} 条`,
    };
    await finishRun(api, report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('规则预览失败', { error: message });
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
  if (command === 'rules-preview') {
    await runRulesPreview();
    return;
  }
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
  if (command === 'proxy-test') {
    await runProxyTest();
    return;
  }
  if (command === 'proxy-fetch-sub') {
    await runProxyFetchSub();
    return;
  }
  if (command === 'cn-probe') {
    await runCnProbe();
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
      const hasProgrammes = epg.programmes > 0 && Boolean(epg.xml);
      let bytes = 0;
      let nextIds = new Set(previousIds);
      if (hasProgrammes) {
        const guide = mergeGuideFallback(
          previousGuide,
          buildGuide(epg.data, new Set(remote.channels.map((channel) => channel.id)), 24),
        );
        nextIds = new Set(Object.keys(guide.channels ?? {}));
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
        await store.put('state/guide.json', JSON.stringify(guide), 'application/json; charset=utf-8');
      } else {
        logger.warn('本轮没有抓到节目单，保留上一版指南');
      }
      const added = [...nextIds].filter((id) => !previousIds.has(id)).length;
      const removed = [...previousIds].filter((id) => !nextIds.has(id)).length;
      await reportTaskProgress(
        api,
        1,
        1,
        hasProgrammes
          ? `EPG 刷新完成 · ${nextIds.size} 频道 · ${epg.programmes} 节目 · 新增 ${added} · 删除 ${removed}`
          : 'EPG 抓取为空，已保留上一版指南',
      );
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
  console.error(redact(`未知命令: ${command}（可用: collect | export | epg | shots）`));
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(redactError('运行失败', error));
  process.exitCode = 1;
});