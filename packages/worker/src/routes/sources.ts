import { Hono } from 'hono';
import { isDueForProbe, mapPool, normalizeUrlForDedupe, parseSource, probeStream, sanitizeSourceHeaders, splitUrlHeaders, validateRemoteUrl, type LineEntry, type ParsedSource, type SourceFilters } from '@iptv/core';
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
import { createTask, dispatchNext } from '../lib/tasks.js';

export const sourceRoutes = new Hono<AppEnv>();

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
  refresh_hours?: number;
  requestHeaders?: unknown;
  fetchMode?: string;
}

sourceRoutes.get('/', async (c) => {
  const [sources, state, channels, fetchReport] = await Promise.all([
    listSources(c.env),
    getJson<{ lines: LineEntry[] }>(c.env, 'state/lines.json'),
    listChannels(c.env),
    getJson<{ generatedAt?: string; sources?: Array<{ sourceId: string; added: number; reused: number; retained: number; disappeared: number; skippedRejected: number }> }>(c.env, 'state/fetch-report.json'),
  ]);
  const reportBySource = new Map((fetchReport?.sources ?? []).map((item) => [item.sourceId, item]));
  const validChannels = new Set(channels.map((channel) => channel.id));
  const unprobeable = /^(rtsp|rtmp|rtmps|udp|rtp):\/\//i;
  const now = new Date();
  const progress = new Map<string, { total: number; tested: number; alive: number; pending: number; pendingTotal: number; quarantine: number; quarantineTotal: number; rejected: number; rejectedTotal: number }>();
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
    if (usable && line.status === 'alive') item.alive++;
    else if (usable && line.status === 'suspect') {
      item.quarantineTotal++;
      if (livenessReady && isDueForProbe(line, 'normal', now)) item.quarantine++;
    } else if (usable && line.status === 'dead') {
      item.rejectedTotal++;
      if (isDueForProbe(line, 'normal', now)) item.rejected++;
    }
    progress.set(line.sourceId, item);
  }
  return ok({
    items: sources.map((source) => ({
      ...source,
      tags: parseJsonField<string[]>(source.tags, []),
      filters: parseJsonField<SourceFilters>(source.filters, {}),
      requestHeaders: parseJsonField<Record<string, string>>(source.request_headers, {}),
      fetchMode: source.fetch_mode ?? 'direct',
      enabled: source.enabled === 1,
      progress: progress.get(source.id) ?? { total: 0, tested: 0, alive: 0, pending: 0, quarantine: 0, rejected: 0 },
      report: reportBySource.get(source.id) ?? null,
    })),
    reportGeneratedAt: fetchReport?.generatedAt ?? null,
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
    items: [...grouped.entries()].map(([sourceId, points]) => ({
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
  return ok({ source: { ...source, tags: parseJsonField<string[]>(source.tags, []), filters: parseJsonField<SourceFilters>(source.filters, {}), requestHeaders: parseJsonField<Record<string, string>>(source.request_headers, {}), fetchMode: source.fetch_mode ?? 'direct', enabled: source.enabled === 1 } });
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
  const fetchMode = input.fetchMode === 'worker' ? 'worker' : 'direct';

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
      origin: 'remote',
      enabled: input.enabled === false ? 0 : 1,
      priority: Number(input.priority ?? 100),
      region: input.region ?? null,
      operator: input.operator ?? null,
      r2Key: null,
      notes: input.notes ?? '等待采集器抓取',
      filters: input.filters ?? null,
      requestHeaders: requestHeaders ?? undefined,
      fetchMode,
      refreshHours: Number(input.refresh_hours ?? 24),
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
    origin,
    enabled: input.enabled === false ? 0 : 1,
    priority: Number(input.priority ?? 100),
    region: input.region ?? null,
    operator: input.operator ?? null,
    r2Key,
    notes: input.notes ?? null,
    filters: input.filters ?? null,
    requestHeaders: requestHeaders ?? undefined,
    fetchMode,
    contentHash,
    refreshHours: Number(input.refresh_hours ?? 24),
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
  if (patch['fetchMode'] !== undefined) {
    patch['fetch_mode'] = patch['fetchMode'] === 'worker' ? 'worker' : 'direct';
    delete patch['fetchMode'];
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

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
