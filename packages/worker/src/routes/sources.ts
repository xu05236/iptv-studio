import { Hono } from 'hono';
import { isDueForProbe, mapPool, normalizeMirrorUrls, normalizeUrlForDedupe, PARSE_DROP_THRESHOLD, parseSource, probeStream, sanitizeSourceHeaders, splitUrlHeaders, validateRemoteUrl, type LineEntry, type ParsedSource, type SourceFilters, type SourceOverlapReport, type SourceParseReport } from '@iptv/core';
import type { AppEnv } from '../env.js';
import {
  deleteSource,
  getSource,
  insertSource,
  listChannels,
  listSources,
  updateSource,
  audit,
} from '../db.js';
import { fail, isoNow, ok, parseJsonField, randomId, readJson } from '../lib/http.js';
import { fetchSourceText } from '../lib/fetcher.js';
import { getText, putText } from '../lib/r2.js';
import { getJson } from '../lib/store.js';
import { loadLines } from '../lib/linesState.js';
import { createTask, dispatchNext } from '../lib/tasks.js';
import { deltaOf, listSourceProgress, parseDelta, saveSourceProgress, type SourceCounts } from '../lib/sourceProgress.js';

export const sourceRoutes = new Hono<AppEnv>();

/** refresh_hours: -1 = follow tiers, 0 = never, N = custom hours (24 = daily). */
function refreshHoursOf(value: unknown): number {
  if (value === null || value === undefined || value === '') return -1;
  const hours = Number(value);
  return Number.isFinite(hours) ? hours : -1;
}

/** Last parse diagnostics plus the "entry count dropped" flag the UI highlights. */
function parseReportOf(row: { parse_report?: string | null }): { parseReport: SourceParseReport | null; parseDrop: boolean } {
  const report = parseJsonField<SourceParseReport | null>(row.parse_report, null);
  const drop = Number(report?.dropPercent ?? 0);
  return { parseReport: report, parseDrop: Number.isFinite(drop) && drop >= PARSE_DROP_THRESHOLD };
}

const MAX_SOURCE_TAGS = 8;

function normalizeTags(input: unknown): string[] {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[,，\n]/)
      : [];
  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const tag = item.trim().slice(0, 24);
    if (tag && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= MAX_SOURCE_TAGS) break;
  }
  return tags;
}

interface CreateSourceInput {
  name?: string;
  url?: string;
  content?: string;
  kind?: string;
  region?: string;
  operator?: string;
  priority?: number;
  enabled?: boolean;
  notes?: string;
  /** Store a remote URL without fetching it now; the runner fetches it later. */
  skipFetch?: boolean;
  filters?: SourceFilters;
  refresh_hours?: number | null;
  tags?: unknown;
  requestHeaders?: unknown;
  mirrorUrls?: unknown;
  fetchMode?: string;
  allowInsecureTls?: boolean;
  fetchTimeoutMs?: number | string;
  fetchConcurrency?: number | string;
  fetchDelayMs?: number | string;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

sourceRoutes.get('/', async (c) => {
  const [sources, state, channels, fetchReport, feedbackRows] = await Promise.all([
    listSources(c.env),
    loadLines(c.env),
    listChannels(c.env),
    getJson<{ generatedAt?: string; sources?: Array<{ sourceId: string } & Record<string, unknown>> }>(c.env, 'state/fetch-report.json'),
    c.env.DB.prepare("SELECT source_id, COUNT(*) AS total FROM feedback WHERE status = 'open' AND source_id IS NOT NULL GROUP BY source_id").all<{ source_id: string; total: number }>(),
  ]);
  const feedbackOpen = new Map((feedbackRows.results ?? []).map((row) => [row.source_id, Number(row.total) || 0]));
  const reportBySource = new Map((fetchReport?.sources ?? []).map((item) => [item.sourceId, item]));
  const validChannels = new Set(channels.map((channel) => channel.id));
  const unprobeable = /^(rtsp|rtmp|rtmps|udp|rtp):\/\//i;
  const now = new Date();
  const progress = new Map<string, { total: number; tested: number; alive: number; pending: number; pendingTotal: number; quarantine: number; quarantineTotal: number; rejected: number; rejectedTotal: number }>();
  const channelSets = new Map<string, Set<string>>();
  for (const line of state?.lines ?? []) {
    const item = progress.get(line.sourceId) ?? { total: 0, tested: 0, alive: 0, pending: 0, pendingTotal: 0, quarantine: 0, quarantineTotal: 0, rejected: 0, rejectedTotal: 0 };
    item.total++;
    if (line.lastProbeAt || line.lastLivenessAt) item.tested++;
    const usable = validChannels.has(line.channelId) && !unprobeable.test(line.url);
    const livenessReady = !line.lastLivenessAt || now.getTime() - Date.parse(line.lastLivenessAt) >= 6 * 3_600_000;
    if (usable && !line.lastProbeAt && line.status === 'unknown') {
      item.pending++;
      item.pendingTotal++;
    }
    if (usable && line.status === 'alive') {
      item.alive++;
      const set = channelSets.get(line.sourceId) ?? new Set<string>();
      set.add(line.channelId);
      channelSets.set(line.sourceId, set);
    } else if (usable && line.status === 'suspect') {
      item.quarantineTotal++;
      if (livenessReady && isDueForProbe(line, 'normal', now)) item.quarantine++;
    } else if (usable && line.status === 'dead') {
      item.rejectedTotal++;
      if (isDueForProbe(line, 'normal', now)) item.rejected++;
    }
    progress.set(line.sourceId, item);
  }

  // Real deltas: compare this report with the probeable counts captured after
  // the source's previous fetch. Both sides now use the same definition, so a
  // genuine drop shows up and the "all lines vs probeable lines" mismatch does
  // not.
  const progressRows = await listSourceProgress(c.env);
  const deltas = new Map<string, SourceCounts | null>();
  const saves: Array<Promise<void>> = [];
  for (const source of sources) {
    const report = reportBySource.get(source.id);
    const reportAt = report && typeof report.fetchedAt === 'string' ? report.fetchedAt : null;
    if (!reportAt) {
      deltas.set(source.id, null);
      continue;
    }
    const item = progress.get(source.id);
    const current: SourceCounts = {
      total: item?.total ?? 0,
      alive: item?.alive ?? 0,
      pending: item?.pendingTotal ?? 0,
      quarantine: item?.quarantineTotal ?? 0,
      rejected: item?.rejectedTotal ?? 0,
    };
    const previous = progressRows.get(source.id);
    if (previous && previous.report_at === reportAt) {
      deltas.set(source.id, parseDelta(previous.delta));
    } else {
      const delta = deltaOf(current, previous ?? null);
      deltas.set(source.id, delta);
      saves.push(saveSourceProgress(c.env, source.id, reportAt, current, delta));
    }
  }
  if (saves.length) await Promise.all(saves);

  return ok({
    items: sources.map((source) => ({
      ...source,
      tags: parseJsonField<string[]>(source.tags, []),
      filters: parseJsonField<SourceFilters>(source.filters, {}),
      requestHeaders: parseJsonField<Record<string, string>>(source.request_headers, {}),
      mirrorUrls: parseJsonField<string[]>(source.mirror_urls, []),
      fetchMode: source.fetch_mode ?? 'direct',
      allowInsecureTls: source.allow_insecure_tls === 1,
      fetchTimeoutMs: source.fetch_timeout_ms ?? 45_000,
      fetchConcurrency: source.fetch_concurrency ?? 1,
      fetchDelayMs: source.fetch_delay_ms ?? 0,
      lastErrorKind: source.last_error_kind ?? null,
      mergeChannelName: source.merge_channel_name ?? null,
      mergeChannelGroup: source.merge_channel_group ?? null,
      ...parseReportOf(source),
      enabled: source.enabled === 1,
      progress: { ...(progress.get(source.id) ?? { total: 0, tested: 0, alive: 0, pending: 0, pendingTotal: 0, quarantine: 0, quarantineTotal: 0, rejected: 0, rejectedTotal: 0 }), channels: channelSets.get(source.id)?.size ?? 0 },
      report: reportBySource.get(source.id) ?? null,
      delta: deltas.get(source.id) ?? null,
      feedbackOpen: feedbackOpen.get(source.id) ?? 0,
      reputation: Math.max(0, Number(source.reputation ?? 0) - (feedbackOpen.get(source.id) ?? 0) * 5),
    })),
    reportGeneratedAt: fetchReport?.generatedAt ?? null,
  });
});

/** Cross-source overlap: precomputed at publish time (see computeSourceOverlap). */
sourceRoutes.get('/overlap', async (c) => {
  const report = await getJson<SourceOverlapReport>(c.env, 'state/source-overlap.json');
  const sources = await listSources(c.env);
  const meta = new Map(sources.map((source) => [source.id, source]));
  const items = (report?.items ?? [])
    .filter((item) => meta.has(item.sourceId))
    .map((item) => {
      const source = meta.get(item.sourceId)!;
      return {
        id: item.sourceId,
        name: source.name,
        enabled: source.enabled === 1,
        reputation: source.reputation,
        total: item.total,
        duplicated: item.duplicated,
        unique: item.unique,
        earliestWins: item.earliestWins,
        share: item.share,
      };
    });
  return ok({
    generatedAt: report?.generatedAt ?? null,
    totalLines: report?.totalLines ?? 0,
    uniqueUrls: report?.uniqueUrls ?? 0,
    duplicateUrls: report?.duplicateUrls ?? 0,
    duplicatedLines: report?.duplicatedLines ?? 0,
    items,
  });
});

sourceRoutes.get('/health', async (c) => {
  const days = Math.min(30, Math.max(1, Number(c.req.query('days') ?? 7) || 7));
  const { results } = await c.env.DB.prepare(
    `SELECT source_id, day, fetched, parsed, alive, dead, avg_speed, avg_latency, reputation
     FROM source_stats
     WHERE day >= date('now', ?)
     ORDER BY day ASC`,
  ).bind(`-${days - 1} days`).all<{
    source_id: string;
    day: string;
    fetched: number;
    parsed: number;
    alive: number;
    dead: number;
    avg_speed: number;
    avg_latency: number;
    reputation: number;
  }>();
  const sources = await listSources(c.env);
  const names = new Map(sources.map((source) => [source.id, source.name]));
  const grouped = new Map<string, typeof results>();
  for (const row of results) {
    const list = grouped.get(row.source_id) ?? [];
    list.push(row);
    grouped.set(row.source_id, list);
  }
  return ok({
    days,
    items: [...grouped.entries()]
      .filter(([sourceId]) => names.has(sourceId))
      .map(([sourceId, points]) => ({
      sourceId,
      name: names.get(sourceId) ?? sourceId,
      points: points.map((point) => ({
        day: point.day,
        fetched: point.fetched === 1,
        parsed: point.parsed,
        alive: point.alive,
        dead: point.dead,
        avgSpeedKbps: point.avg_speed,
        avgLatencyMs: point.avg_latency,
        reputation: point.reputation,
      })),
    })),
  });
});

sourceRoutes.post('/preview', async (c) => {
  const body = (await readJson<{ url?: string; content?: string }>(c)) ?? {};
  if (!body.url && !body.content) return fail('请提供订阅地址或内容');

  const existing = await listSources(c.env);
  if (body.url) {
    const validation = validateRemoteUrl(body.url);
    if (!validation.ok) return fail(validation.reason ?? '订阅地址不合法');
    const normalized = normalizeUrlForDedupe(body.url);
    const duplicate = existing.find((source) => source.url && normalizeUrlForDedupe(source.url) === normalized);
    if (duplicate) {
      return ok({ exists: true, duplicateOf: { id: duplicate.id, name: duplicate.name, reason: 'url' }, reachable: true, entries: duplicate.entry_count });
    }
    const fetched = await fetchSourceText(body.url);
    if (!fetched.ok || !fetched.text) {
      return ok({ exists: false, reachable: false, error: fetched.error ?? '抓取失败', entries: 0, warnings: ['源站可能限制 Cloudflare/海外 IP，可勾选「跳过预检」交给采集器抓取'] });
    }
    return summarizePreview(fetched.text, existing);
  }

  const text = body.content ?? '';
  if (text.length > 24 * 1024 * 1024) return fail('内容超过 24MB 限制', 413);
  return summarizePreview(text, existing);
});

async function summarizePreview(text: string, existing: Awaited<ReturnType<typeof listSources>>) {
  const contentHash = await sha256(text);
  const duplicateContent = existing.find((source) => source.content_hash === contentHash);
  if (duplicateContent) {
    return ok({ exists: true, duplicateOf: { id: duplicateContent.id, name: duplicateContent.name, reason: 'content' }, reachable: true, entries: duplicateContent.entry_count });
  }
  if (text.length > 512 * 1024) {
    return ok({ exists: false, reachable: true, entries: 0, warnings: ['内容较大，添加后由采集器解析'], groups: [], sample: [] });
  }
  const parsed = parseSource(text, 'auto');
  const counts = new Map<string, number>();
  for (const entry of parsed.entries) {
    const group = entry.group?.trim() || '未分组';
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([group, count]) => ({ group, count }));
  return ok({
    exists: false,
    reachable: true,
    entries: parsed.entries.length,
    groups,
    sample: parsed.entries.slice(0, 8),
    warnings: parsed.warnings,
  });
}

sourceRoutes.get('/:id', async (c) => {
  const source = await getSource(c.env, c.req.param('id'));
  if (!source) return fail('直播源不存在', 404);
  return ok({ source: { ...source, tags: parseJsonField<string[]>(source.tags, []), filters: parseJsonField<SourceFilters>(source.filters, {}), requestHeaders: parseJsonField<Record<string, string>>(source.request_headers, {}), mirrorUrls: parseJsonField<string[]>(source.mirror_urls, []), fetchMode: source.fetch_mode ?? 'direct', allowInsecureTls: source.allow_insecure_tls === 1, fetchTimeoutMs: source.fetch_timeout_ms ?? 45_000, fetchConcurrency: source.fetch_concurrency ?? 1, fetchDelayMs: source.fetch_delay_ms ?? 0, lastErrorKind: source.last_error_kind ?? null, ...parseReportOf(source), enabled: source.enabled === 1 } });
});

/**
 * F3：Worker 代拉源内容。GitHub Actions 出口被源站/CDN 拦时，源设 fetch_mode=worker，
 * runner 调这里拿正文再在本地解析；正文只在响应里返回，不落 KV。
 */
sourceRoutes.post('/:id/fetch', async (c) => {
  const source = await getSource(c.env, c.req.param('id'));
  if (!source) return fail('直播源不存在', 404);
  if (source.status === 'paused') return fail('源已暂停，先恢复再代拉', 409);
  const headers = parseJsonField<Record<string, string>>(source.request_headers, {});
  const mirrors = normalizeMirrorUrls(source.mirror_urls);
  if (mirrors.error) return fail(mirrors.error);
  const candidates: Array<string | null> = [source.url, ...mirrors.urls];
  const urls = candidates.filter((url): url is string => typeof url === 'string' && /^https?:\/\//i.test(url));
  if (!urls.length) return fail('该源没有可由 Worker 代拉的 http(s) 地址', 400);
  const timeoutMs = clampNumber(source.fetch_timeout_ms, 2_000, 120_000, 45_000);
  let lastError = 'Worker 代拉失败';
  for (const [index, url] of urls.entries()) {
    const result = await fetchSourceText(url, { headers, timeoutMs, maxBytes: 8 * 1024 * 1024 });
    if (result.notModified) return ok({ notModified: true, mirrorIndex: index });
    if (result.ok && result.text) {
      return ok({
        text: result.text,
        encoding: result.encoding ?? 'utf-8',
        status: result.status,
        etag: result.etag ?? null,
        lastModified: result.lastModified ?? null,
        mirrorIndex: index,
      });
    }
    lastError = result.error ?? `HTTP ${result.status}`;
  }
  return fail(`Worker 代拉失败：${lastError}`, 502, 'worker_fetch_failed');
});

sourceRoutes.get('/:id/detail', async (c) => {
  const id = c.req.param('id');
  const [source, state, fetchReport] = await Promise.all([
    getSource(c.env, id),
    loadLines(c.env),
    getJson<{ generatedAt?: string; sources?: Array<{ sourceId: string } & Record<string, unknown>> }>(c.env, 'state/fetch-report.json'),
  ]);
  if (!source) return fail('直播源不存在', 404);

  const now = new Date();
  const lines = (state?.lines ?? []).filter((line) => line.sourceId === id);
  // Count only lines that can actually be probed, so the detail page matches
  // the source card (invalid channel / rtsp+udp lines are not "待测").
  const { results: channelRows } = await c.env.DB.prepare('SELECT id FROM channels').all<{ id: string }>();
  const validChannels = new Set(channelRows.map((row) => row.id));
  const unprobeable = /^(rtsp|rtmp|rtmps|udp|rtp):\/\//i;
  const stats = { total: lines.length, alive: 0, pending: 0, quarantine: 0, rejected: 0, tested: 0, dueQuarantine: 0, duePending: 0 };
  let lastProbeAt: string | null = null;
  let oldestAliveProbeAt: string | null = null;
  for (const line of lines) {
    if (line.lastProbeAt || line.lastLivenessAt) stats.tested++;
    if (line.lastProbeAt && (!lastProbeAt || line.lastProbeAt > lastProbeAt)) lastProbeAt = line.lastProbeAt;
    const usable = validChannels.has(line.channelId) && !unprobeable.test(line.url);
    if (!usable) continue;
    if (line.status === 'alive') {
      stats.alive++;
      if (line.lastProbeAt && (!oldestAliveProbeAt || line.lastProbeAt < oldestAliveProbeAt)) oldestAliveProbeAt = line.lastProbeAt;
    } else if (line.status === 'suspect') {
      stats.quarantine++;
      if (isDueForProbe(line, 'normal', now)) stats.dueQuarantine++;
    } else if (line.status === 'dead') {
      stats.rejected++;
    } else if (line.status === 'unknown' && !line.lastProbeAt) {
      stats.pending++;
      stats.duePending++;
    }
  }

  const reportItem = (fetchReport?.sources ?? []).find((item) => item.sourceId === id) ?? null;
  const reportAt = reportItem && typeof reportItem.fetchedAt === 'string' ? reportItem.fetchedAt : null;
  let delta: SourceCounts | null = null;
  if (reportAt) {
    const rows = await listSourceProgress(c.env);
    const previous = rows.get(id);
    if (previous && previous.report_at === reportAt) {
      delta = parseDelta(previous.delta);
    } else {
      delta = deltaOf(stats, previous ?? null);
      await saveSourceProgress(c.env, id, reportAt, stats, delta);
    }
  }

  const days = Math.min(30, Math.max(1, Number(c.req.query('days') ?? 7) || 7));
  const { results: healthRows } = await c.env.DB.prepare(
    `SELECT day, fetched, parsed, alive, dead, avg_speed, avg_latency, reputation
     FROM source_stats WHERE source_id = ? AND day >= date('now', ?) ORDER BY day ASC`,
  ).bind(id, `-${days - 1} days`).all<{
    day: string; fetched: number; parsed: number; alive: number; dead: number; avg_speed: number; avg_latency: number; reputation: number;
  }>();

  return ok({
    source: {
      ...source,
      tags: parseJsonField<string[]>(source.tags, []),
      filters: parseJsonField<SourceFilters>(source.filters, {}),
      requestHeaders: parseJsonField<Record<string, string>>(source.request_headers, {}),
      mirrorUrls: parseJsonField<string[]>(source.mirror_urls, []),
      fetchMode: source.fetch_mode ?? 'direct',
      allowInsecureTls: source.allow_insecure_tls === 1,
      fetchTimeoutMs: source.fetch_timeout_ms ?? 45_000,
      fetchConcurrency: source.fetch_concurrency ?? 1,
      fetchDelayMs: source.fetch_delay_ms ?? 0,
      lastErrorKind: source.last_error_kind ?? null,
      ...parseReportOf(source),
      enabled: source.enabled === 1,
    },
    stats,
    delta,
    lastProbeAt,
    oldestAliveProbeAt,
    health: {
      days,
      points: healthRows.map((row) => ({
        day: row.day,
        fetched: row.fetched === 1,
        parsed: row.parsed,
        alive: row.alive,
        dead: row.dead,
        avgSpeedKbps: row.avg_speed,
        avgLatencyMs: row.avg_latency,
        reputation: row.reputation,
      })),
    },
    report: (fetchReport?.sources ?? []).find((item) => item.sourceId === id) ?? null,
    reportGeneratedAt: fetchReport?.generatedAt ?? null,
  });
});

sourceRoutes.get('/:id/content', async (c) => {
  const source = await getSource(c.env, c.req.param('id'));
  if (!source) return fail('直播源不存在', 404);
  if (!source.r2_key) return fail('该源为远程订阅，无本地内容', 404);
  const text = await getText(c.env, source.r2_key);
  if (text === null) return fail('内容文件不存在', 404);
  return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
});

sourceRoutes.post('/', async (c) => {
  const contentType = c.req.header('content-type') ?? '';
  let input: CreateSourceInput = {};

  if (contentType.includes('application/json')) {
    input = (await readJson<CreateSourceInput>(c)) ?? {};
  } else if (contentType.includes('multipart/form-data')) {
    const body = await c.req.parseBody();
    const file = body['file'];
    input = {
      name: typeof body['name'] === 'string' ? body['name'] : undefined,
      kind: typeof body['kind'] === 'string' ? body['kind'] : undefined,
      region: typeof body['region'] === 'string' ? body['region'] : undefined,
      operator: typeof body['operator'] === 'string' ? body['operator'] : undefined,
      content: file instanceof File ? await file.text() : typeof body['content'] === 'string' ? body['content'] : undefined,
    };
  } else {
    input = { content: await c.req.text(), name: c.req.query('name') ?? undefined, kind: c.req.query('kind') ?? undefined };
  }

  if (!input.url && !input.content) return fail('请提供订阅地址或文件/文本内容');
  if (input.content && input.content.length > 24 * 1024 * 1024) return fail('内容超过 24MB 限制', 413);

  const headerCheck = sanitizeSourceHeaders(input.requestHeaders);
  if (!headerCheck.ok) return fail(headerCheck.error ?? '请求设置不合法');
  const requestHeaders = Object.keys(headerCheck.headers).length ? headerCheck.headers : null;
  const mirrorCheck = normalizeMirrorUrls(input.mirrorUrls);
  if (mirrorCheck.error) return fail(mirrorCheck.error);
  const fetchMode = input.fetchMode === 'worker' ? 'worker' : 'direct';
  const fetchTimeoutMs = clampNumber(input.fetchTimeoutMs, 2_000, 120_000, 45_000);
  const fetchConcurrency = clampNumber(input.fetchConcurrency, 1, 4, 1);
  const fetchDelayMs = clampNumber(input.fetchDelayMs, 0, 5_000, 0);
  const allowInsecureTls = input.allowInsecureTls === true ? 1 : 0;
  const tags = normalizeTags(input.tags);

  const existingSources = await listSources(c.env);
  if (input.url) {
    const normalized = normalizeUrlForDedupe(input.url);
    const duplicate = existingSources.find((source) => source.url && normalizeUrlForDedupe(source.url) === normalized);
    if (duplicate) return fail(`该订阅已存在：${duplicate.name}`, 409);
  }

  if (input.url && input.skipFetch) {
    const id = `src-${randomId(8)}`;
    const pendingName = input.name?.trim() || new URL(input.url).hostname;
    await insertSource(c.env, {
      id,
      name: pendingName,
      kind: input.kind ?? 'auto',
      url: input.url,
      mirrorUrls: mirrorCheck.urls,
      origin: 'remote',
      enabled: input.enabled === false ? 0 : 1,
      priority: Number(input.priority ?? 100),
      region: input.region ?? null,
      operator: input.operator ?? null,
      r2Key: null,
      notes: input.notes ?? '等待采集器抓取',
      tags: tags.length ? JSON.stringify(tags) : undefined,
      filters: input.filters ?? null,
      requestHeaders: requestHeaders ?? undefined,
      fetchMode,
      fetchTimeoutMs,
      fetchConcurrency,
      fetchDelayMs,
      allowInsecureTls,
      refreshHours: refreshHoursOf(input.refresh_hours),
    });
    await audit(c.env, c.get('actor'), 'source.create.skip_fetch', id, { url: input.url });
    const task = await createTask(c.env, {
      type: 'fetch',
      source: 'source',
      priority: 80,
      payload: { source_id: id, force: 'true' },
      message: '新增源自动抓取',
    });
    await dispatchNext(c.env);
    return ok(
      {
        source: await getSource(c.env, id),
        taskId: task.id,
        summary: { kind: input.kind ?? 'auto', entries: 0, groups: [], sample: [], warnings: ['已跳过预检，采集器会在下一轮抓取'] },
      },
      201,
    );
  }

  let text = input.content ?? '';
  let etag: string | null = null;
  let lastModified: string | null = null;
  let origin: 'remote' | 'upload' | 'paste' = 'paste';

  if (input.url) {
    const validation = validateRemoteUrl(input.url);
    if (!validation.ok) return fail(validation.reason ?? '订阅地址不合法');
    const fetched = await fetchSourceText(input.url, { headers: requestHeaders ?? undefined });
    if (!fetched.ok || fetched.notModified) return fail(`抓取失败：${fetched.error ?? '未知错误'}。若源站限制 Cloudflare/海外 IP，可勾选「跳过预检」交给采集器抓取，或下载后上传文件。`);
    text = fetched.text ?? '';
    etag = fetched.etag ?? null;
    lastModified = fetched.lastModified ?? null;
    origin = 'remote';
  } else if (contentType.includes('multipart/form-data')) {
    origin = 'upload';
  }

  const contentHash = await sha256(text);
  const duplicateContent = existingSources.find((source) => source.content_hash === contentHash);
  if (duplicateContent) return fail(`相同内容已存在：${duplicateContent.name}`, 409);

  // Parsing a 1.5MB / 8000-entry playlist exceeds the Workers free CPU budget.
  // Store it now and let the runner parse it during collect.
  const parsed: ParsedSource | null = text.length <= 512 * 1024 ? parseSource(text, (input.kind as never) ?? 'auto') : null;
  if (parsed && !parsed.entries.length) {
    return fail(`解析失败：${parsed.warnings.join('；') || '未发现有效频道条目'}`, 422);
  }

  const id = `src-${randomId(8)}`;
  const name =
    input.name?.trim() ||
    (input.url ? new URL(input.url).hostname : `文本导入 ${new Date().toLocaleDateString('zh-CN')}`);

  const r2Key = origin === 'remote' ? null : `sources/${id}.txt`;
  if (r2Key) await putText(c.env, r2Key, text);

  await insertSource(c.env, {
    id,
    name,
    kind: input.kind ?? 'auto',
    url: input.url ?? null,
    mirrorUrls: mirrorCheck.urls,
    origin,
    enabled: input.enabled === false ? 0 : 1,
    priority: Number(input.priority ?? 100),
    region: input.region ?? null,
    operator: input.operator ?? null,
    r2Key,
    notes: input.notes ?? null,
    tags: tags.length ? JSON.stringify(tags) : undefined,
    filters: input.filters ?? null,
    requestHeaders: requestHeaders ?? undefined,
    fetchMode,
    fetchTimeoutMs,
    fetchConcurrency,
    fetchDelayMs,
    allowInsecureTls,
    contentHash,
    refreshHours: refreshHoursOf(input.refresh_hours),
  });

  await updateSource(c.env, id, {
    entry_count: parsed?.entries.length ?? 0,
    last_fetch_at: isoNow(),
    last_ok_at: parsed ? isoNow() : null,
    last_error: null,
    etag,
    last_modified: lastModified,
  });
  await audit(c.env, c.get('actor'), 'source.create', id, { name, origin, entries: parsed?.entries.length ?? 0 });
  const task = await createTask(c.env, {
    type: 'fetch',
    source: 'source',
    priority: 80,
    payload: { source_id: id, force: 'true' },
    message: '新增源自动抓取',
  });
  await dispatchNext(c.env);

  if (!parsed) {
    return ok(
      {
        source: await getSource(c.env, id),
        taskId: task.id,
        summary: {
          kind: input.kind ?? 'auto',
          entries: 0,
          groups: [],
          sample: [],
          warnings: ['内容较大，已保存，采集器会在下一次运行时解析'],
        },
      },
      201,
    );
  }

  return ok(
    {
      source: await getSource(c.env, id),
      taskId: task.id,
      summary: {
        kind: parsed.kind,
        entries: parsed.entries.length,
        groups: [...new Set(parsed.entries.map((entry) => entry.group).filter(Boolean))].slice(0, 30),
        sample: parsed.entries.slice(0, 10),
        warnings: parsed.warnings,
      },
    },
    201,
  );
});

sourceRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const source = await getSource(c.env, id);
  if (!source) return fail('直播源不存在', 404);
  const patch = (await readJson<Record<string, unknown>>(c)) ?? {};
  if (patch['url']) {
    const validation = validateRemoteUrl(String(patch['url']));
    if (!validation.ok) return fail(validation.reason ?? '订阅地址不合法');
  }
  if (patch['filters'] && typeof patch['filters'] !== 'object') return fail('filters 必须是对象');
  if (patch['requestHeaders'] !== undefined) {
    const headerCheck = sanitizeSourceHeaders(patch['requestHeaders']);
    if (!headerCheck.ok) return fail(headerCheck.error ?? '请求设置不合法');
    patch['request_headers'] = Object.keys(headerCheck.headers).length ? JSON.stringify(headerCheck.headers) : null;
    delete patch['requestHeaders'];
    // 新的请求头可能改变源站返回内容，下一次必须重新抓取。
    patch.etag = null;
    patch.last_modified = null;
    patch.last_fetch_at = null;
  }
  if (patch['tags'] !== undefined) {
    patch['tags'] = JSON.stringify(normalizeTags(patch['tags']));
  }
  if (patch['fetchMode'] !== undefined) {
    patch['fetch_mode'] = patch['fetchMode'] === 'worker' ? 'worker' : 'direct';
    delete patch['fetchMode'];
  }
  if (patch['allowInsecureTls'] !== undefined) {
    patch['allow_insecure_tls'] = patch['allowInsecureTls'] ? 1 : 0;
    delete patch['allowInsecureTls'];
    // Turning the switch on is an explicit "retry this source" request. Without
    // this, a source paused by TLS failures stays paused and the collector keeps
    // skipping it, which looks like the switch did nothing.
    if (patch['allow_insecure_tls'] === 1 && source.status === 'paused') {
      patch['status'] = 'active';
      patch['consecutive_failures'] = 0;
    }
  }
  if (patch['mirrorUrls'] !== undefined) {
    const mirrorCheck = normalizeMirrorUrls(patch['mirrorUrls']);
    if (mirrorCheck.error) return fail(mirrorCheck.error);
    patch['mirror_urls'] = mirrorCheck.urls.length ? JSON.stringify(mirrorCheck.urls) : null;
    delete patch['mirrorUrls'];
    // Mirrors change which body we may get; force a fresh fetch next round.
    patch.etag = null;
    patch.last_modified = null;
    patch.last_fetch_at = null;
  }
  // F5: per-source fetch parameters (timeout / mirror concurrency / polite delay).
  if (patch['fetchTimeoutMs'] !== undefined) {
    patch['fetch_timeout_ms'] = clampNumber(patch['fetchTimeoutMs'], 2_000, 120_000, 45_000);
    delete patch['fetchTimeoutMs'];
  }
  if (patch['fetchConcurrency'] !== undefined) {
    patch['fetch_concurrency'] = clampNumber(patch['fetchConcurrency'], 1, 4, 1);
    delete patch['fetchConcurrency'];
  }
  if (patch['fetchDelayMs'] !== undefined) {
    patch['fetch_delay_ms'] = clampNumber(patch['fetchDelayMs'], 0, 5_000, 0);
    delete patch['fetchDelayMs'];
  }
  // A filter change must be re-applied to the full source text. Drop the
  // conditional-request validators and the refresh timestamp so the next
  // collect fetches the body immediately instead of reusing a 304.
  if (patch['filters'] !== undefined && JSON.stringify(patch['filters']) !== (source.filters ?? '')) {
    patch.etag = null;
    patch.last_modified = null;
    patch.last_fetch_at = null;
  }
  if (patch['url'] && String(patch['url']) !== (source.url ?? '')) {
    patch.etag = null;
    patch.last_modified = null;
    patch.last_fetch_at = null;
  }
  if (patch['refresh_hours'] !== undefined) {
    patch['refresh_hours'] = refreshHoursOf(patch['refresh_hours']);
  }
  // Optional channel folding for live-platform sources: every line of the
  // source is attached to one channel (e.g. 虎牙直播) in the given group.
  for (const key of ['mergeChannelName', 'mergeChannelGroup'] as const) {
    if (patch[key] !== undefined) {
      const value = String(patch[key] ?? '').trim();
      patch[key] = value || null;
    }
  }
  const updated = await updateSource(c.env, id, patch);
  if (!updated) return fail('没有可更新的字段');
  await audit(c.env, c.get('actor'), 'source.update', id, patch);
  return ok({ source: await getSource(c.env, id) });
});

sourceRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const source = await getSource(c.env, id);
  if (!source) return fail('直播源不存在', 404);
  if (source.r2_key) await c.env.KV.delete(source.r2_key);
  await deleteSource(c.env, id);
  await audit(c.env, c.get('actor'), 'source.delete', id);
  return ok({ ok: true });
});

/** Re-fetch a source, parse it and report what it currently contains. */
sourceRoutes.post('/:id/probe', async (c) => {
  const id = c.req.param('id');
  const source = await getSource(c.env, id);
  if (!source) return fail('直播源不存在', 404);

  let text: string | null = null;
  let etag = source.etag;
  let lastModified = source.last_modified;

  if (source.r2_key) {
    text = await getText(c.env, source.r2_key);
  } else if (source.url) {
    const fetched = await fetchSourceText(source.url, { etag: source.etag, lastModified: source.last_modified });
    if (fetched.notModified) {
      return ok({ notModified: true, message: '内容未变化 (304)', source });
    }
    if (!fetched.ok) {
      await updateSource(c.env, id, { last_fetch_at: isoNow(), last_error: fetched.error ?? '抓取失败' });
      return fail(`抓取失败：${fetched.error ?? '未知错误'}`, 502);
    }
    text = fetched.text ?? '';
    etag = fetched.etag ?? null;
    lastModified = fetched.lastModified ?? null;
  }

  if (!text) return fail('没有可解析的内容', 422);
  const parsed = parseSource(text, source.kind as never);

  await updateSource(c.env, id, {
    entry_count: parsed.entries.length,
    last_fetch_at: isoNow(),
    last_ok_at: isoNow(),
    last_error: null,
    etag,
    last_modified: lastModified,
  });

  const groups = new Map<string, number>();
  for (const entry of parsed.entries) {
    const group = entry.group ?? '未分组';
    groups.set(group, (groups.get(group) ?? 0) + 1);
  }

  return ok({
    source: await getSource(c.env, id),
    summary: {
      kind: parsed.kind,
      entries: parsed.entries.length,
      groups: [...groups.entries()].map(([group, count]) => ({ group, count })).sort((a, b) => b.count - a.count),
      sample: parsed.entries.slice(0, 20),
      warnings: parsed.warnings,
    },
  });
});

/** Probe a sample of lines straight from the Worker (bounded, no Actions needed). */
sourceRoutes.post('/:id/probe-lines', async (c) => {
  const id = c.req.param('id');
  const source = await getSource(c.env, id);
  if (!source) return fail('直播源不存在', 404);

  const body = (await readJson<{ limit?: number; offset?: number }>(c)) ?? {};
  const limit = Math.max(1, Math.min(Number(body.limit ?? 8), 24));
  const offset = Math.max(0, Number(body.offset ?? 0));

  let text: string | null = source.r2_key ? await getText(c.env, source.r2_key) : null;
  if (!text && source.url) {
    const fetched = await fetchSourceText(source.url);
    if (!fetched.ok) return fail(`抓取失败：${fetched.error}`, 502);
    text = fetched.text ?? '';
  }
  if (!text) return fail('没有可解析的内容', 422);

  const parsed = parseSource(text, source.kind as never);
  const candidates = parsed.entries
    .slice(offset, offset + limit)
    .map((entry, index) => ({ key: `${offset + index}`, url: splitUrlHeaders(entry.url).url, headers: entry.headers }));

  const started = Date.now();
  const results = await mapPool(candidates, 4, async (item) => {
    const result = await probeStream(item.url, { headers: item.headers, timeoutMs: 8_000, warmupBytes: 256 * 1024, sampleMs: 1_200 });
    return { index: Number(item.key), name: parsed.entries[Number(item.key)]?.name, url: item.url, result };
  });

  return ok({
    total: parsed.entries.length,
    probed: results.length,
    alive: results.filter((item) => item.result.ok).length,
    elapsedMs: Date.now() - started,
    results,
  });
});

sourceRoutes.post('/:id/toggle', async (c) => {
  const id = c.req.param('id');
  const source = await getSource(c.env, id);
  if (!source) return fail('直播源不存在', 404);
  const enabling = source.enabled !== 1;
  // Re-enabling a source that was auto-paused by repeated failures also clears
  // the paused status, otherwise the collector would keep skipping it.
  await updateSource(c.env, id, {
    enabled: enabling ? 1 : 0,
    ...(enabling && source.status === 'paused' ? { status: 'active', consecutive_failures: 0 } : {}),
  });
  return ok({ source: await getSource(c.env, id) });
});

sourceRoutes.post('/:id/recover', async (c) => {
  const id = c.req.param('id');
  const source = await getSource(c.env, id);
  if (!source) return fail('直播源不存在', 404);
  await updateSource(c.env, id, { enabled: 1, status: 'active', consecutive_failures: 0 });
  const task = await createTask(c.env, {
    type: 'fetch',
    source: 'source',
    priority: 90,
    payload: { source_id: id, force: 'false', budget: '0' },
    message: `重试恢复 ${source.name}`,
  });
  const dispatched = await dispatchNext(c.env);
  await audit(c.env, c.get('actor'), 'source.recover', id, { taskId: task.id });
  return ok({ source: await getSource(c.env, id), taskId: task.id, message: dispatched.message });
});

/**
 * Fetch a single source on demand. The runner scopes a fetch task to one source
 * via SOURCE_ID, so this refreshes ~1 source instead of the whole list. A paused
 * or disabled source is revived first, otherwise the runner would skip it.
 */
sourceRoutes.post('/:id/fetch-now', async (c) => {
  const id = c.req.param('id');
  const source = await getSource(c.env, id);
  if (!source) return fail('直播源不存在', 404);
  if (source.enabled !== 1 || source.status !== 'active') {
    await updateSource(c.env, id, { enabled: 1, status: 'active', consecutive_failures: 0 });
  }
  const task = await createTask(c.env, {
    type: 'fetch',
    source: 'manual',
    priority: 100,
    payload: { source_id: id, force: 'false', force_fetch: 'true', budget: '0' },
    message: `手动抓源 ${source.name}`,
  });
  const dispatched = await dispatchNext(c.env);
  await audit(c.env, c.get('actor'), 'source.fetch_now', id, { taskId: task.id });
  return ok({ ok: true, taskId: task.id, message: dispatched.message });
});

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
