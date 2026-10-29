import { Hono } from 'hono';
import { probeStream, type AppSettings, type Rule } from '@iptv/core';
import type { AppEnv } from '../env.js';
import {
  applySourceStats,
  audit,
  countOpenFeedback,
  deleteRule,
  getRun,
  insertFeedback,
  listFeedback,
  listRules,
  listRuns,
  listSources,
  loadSettings,
  saveSettings,
  updateFeedback,
  upsertChannelSeeds,
  upsertRule,
  upsertRun,
  getChannel,
  listChannels,
  listSubscriptions,
  type RuleRow,
} from '../db.js';
import { fail, ok, parseJsonField, readJson, randomId } from '../lib/http.js';
import { inferResolution } from '@iptv/core';
import { dispatchWorkflow, workflowRunStatus } from '../lib/github.js';
import { getText, getJson, listArtifacts, putArtifact } from '../lib/store.js';
import { loadCatalog, loadGuide, loadIndex } from '../lib/catalog.js';
import { sourceMetaMap } from '../lib/source.js';

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.get('/epg/coverage', async (c) => {
  const [index, guide] = await Promise.all([loadIndex(c.env), loadGuide(c.env)]);
  if (!index) return ok({ total: 0, covered: 0, percent: 0, missing: [], missingTotal: 0 });
  const data = (guide ?? {}) as Record<string, unknown>;
  const coveredIds = new Set(
    Object.entries(data)
      .filter(([channelId, programmes]) => channelId !== 'generatedAt' && Array.isArray(programmes) && programmes.length > 0)
      .map(([channelId]) => channelId),
  );
  const missing = index.channels.filter((channel) => !coveredIds.has(channel.id));
  const total = index.channels.length;
  return ok({
    total,
    covered: total - missing.length,
    percent: total ? Math.round(((total - missing.length) / total) * 100) : 0,
    missing: missing.slice(0, 100).map((channel) => ({ id: channel.id, name: channel.name, group: channel.group })),
    missingTotal: missing.length,
  });
});

adminRoutes.get('/stats', async (c) => {
  const [index, sources, channels, subscriptions, feedbackOpen, runs] = await Promise.all([
    loadIndex(c.env),
    listSources(c.env),
    listChannels(c.env),
    listSubscriptions(c.env),
    countOpenFeedback(c.env),
    listRuns(c.env, 5),
  ]);

  const reputation = { high: 0, normal: 0, low: 0 };
  for (const source of sources) {
    if (source.reputation >= 80) reputation.high++;
    else if (source.reputation >= 50) reputation.normal++;
    else reputation.low++;
  }

  return ok({
    index: index
      ? {
          ready: true,
          generatedAt: index.generatedAt,
          runId: index.runId,
          totals: { channels: index.totalChannels, lines: index.totalLines, alive: index.aliveLines },
          groups: index.groups,
        }
      : { ready: false, totals: { channels: 0, lines: 0, alive: 0 }, groups: [] },
    sources: {
      total: sources.length,
      enabled: sources.filter((source) => source.enabled === 1).length,
      failing: sources.filter((source) => source.status === 'degraded').length,
      reputation,
    },
    channels: channels.length,
    subscriptions: subscriptions.length,
    feedbackOpen,
    runs,
  });
});

adminRoutes.get('/runs', async (c) => {
  const limit = Math.max(1, Math.min(Number(c.req.query('limit') ?? 20), 100));
  const runs = await listRuns(c.env, limit);
  return ok({
    items: runs.map((run) => ({ ...run, warnings: parseJsonField<string[]>(run.warnings, []) })),
  });
});

adminRoutes.get('/runs/github', async (c) => {
  return ok({ runs: await workflowRunStatus(c.env) });
});

adminRoutes.get('/runs/:id', async (c) => {
  const run = await getRun(c.env, c.req.param('id'));
  if (!run) return fail('运行记录不存在', 404);
  return ok({ run: { ...run, warnings: parseJsonField<string[]>(run.warnings, []) } });
});

adminRoutes.get('/runs/:id/log', async (c) => {
  const run = await getRun(c.env, c.req.param('id'));
  if (!run) return fail('运行记录不存在', 404);
  if (!run.log_key) return fail('该运行没有日志文件', 404);
  const text = await getText(c.env, run.log_key);
  if (text === null) return fail('日志文件不存在', 404);
  return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
});

adminRoutes.post('/runs/dispatch', async (c) => {
  const body = (await readJson<{ command?: string; force?: boolean; budget?: number | string; sourceId?: string }>(c)) ?? {};
  const command = body.command === 'export' ? 'export' : body.command === 'epg' ? 'epg' : 'collect';
  const force = Boolean(body.force);
  // GitHub rejects any input that is not declared in the workflow file, so only
  // send the keys collect.yml actually defines.
  const result = await dispatchWorkflow(c.env, {
    command,
    force: force ? 'true' : 'false',
    budget: String(body.budget ?? (force ? 6000 : 1200)),
    source_id: body.sourceId?.trim() ?? '',
  });
  await audit(c.env, c.get('actor'), 'run.dispatch', 'github', result);
  if (!result.ok) return fail(result.message, 400, 'dispatch_failed');
  return ok(result, 202);
});

/** Runner callbacks: persist the run summary (artifacts already live in R2). */
adminRoutes.post('/runs', async (c) => {
  const report = await readJson<Record<string, unknown>>(c);
  if (!report || !report['id']) return fail('缺少运行 ID');
  await upsertRun(c.env, report as never);
  return ok({ ok: true });
});

adminRoutes.get('/rules', async (c) => {
  const rules = await listRules(c.env);
  return ok({
    items: rules.map((row) => ({
      ...row,
      enabled: row.enabled === 1,
      ...parseJsonField<{ match?: unknown; actions?: unknown }>(row.spec, {}),
    })),
  });
});

adminRoutes.post('/rules', async (c) => {
  const body = await readJson<Partial<Rule>>(c);
  if (!body || !body.name) return fail('规则名称不能为空');
  const row: RuleRow = {
    id: body.id ?? `rule-${randomId(8)}`,
    name: body.name,
    enabled: body.enabled === false ? 0 : 1,
    priority: Number(body.priority ?? 100),
    kind: body.actions?.exclude ? 'filter' : 'classify',
    spec: JSON.stringify({ match: body.match ?? {}, actions: body.actions ?? {} }),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await upsertRule(c.env, row);
  return ok({ rule: row });
});

adminRoutes.delete('/rules/:id', async (c) => {
  await deleteRule(c.env, c.req.param('id'));
  return ok({ ok: true });
});

adminRoutes.get('/settings', async (c) => {
  const settings = await loadSettings(c.env);
  return ok({ settings, publicBaseUrl: c.env.PUBLIC_BASE_URL ?? new URL(c.req.url).origin });
});

adminRoutes.put('/settings', async (c) => {
  const patch = await readJson<Partial<AppSettings>>(c);
  if (!patch) return fail('请求体不合法');
  const allowed: Array<keyof AppSettings> = [
    'logoBaseUrl', 'maxLinesPerChannel', 'maxLinesPerSource', 'compensate', 'keepSuspect', 'deadReviveDays',
    'probeBudget', 'concurrency', 'probeTimeoutMs', 'warmupBytes', 'sampleMs', 'epgUrls', 'regionSuffix',
    'notifyTelegram', 'retentionDays', 'screenshots', 'relayEnabled', 'directPlayback',
  ];
  const clean: Partial<AppSettings> = {};
  for (const key of allowed) {
    if (key in patch) (clean as Record<string, unknown>)[key] = patch[key];
  }
  const settings = await saveSettings(c.env, clean);
  return ok({ settings });
});

adminRoutes.get('/feedback', async (c) => {
  const status = c.req.query('status') ?? 'open';
  const feedback = await listFeedback(c.env, status, 100);
  return ok({ items: feedback });
});

adminRoutes.post('/feedback/:id/status', async (c) => {
  const body = await readJson<{ status?: string }>(c);
  const status = body?.status ?? 'resolved';
  if (!['open', 'resolved', 'ignored'].includes(status)) return fail('状态不合法');
  await updateFeedback(c.env, c.req.param('id'), status);
  return ok({ ok: true });
});

/** Manual feedback entry (e.g. operator reporting a broken line from the admin UI). */
adminRoutes.post('/feedback', async (c) => {
  const body = await readJson<{ channelId?: string; entryKey?: string; sourceId?: string; kind?: string; message?: string }>(c);
  const id = `fb-${randomId(10)}`;
  await insertFeedback(c.env, {
    id,
    entry_key: body?.entryKey ?? null,
    channel_id: body?.channelId ?? null,
    source_id: body?.sourceId ?? null,
    kind: body?.kind ?? 'dead',
    message: body?.message ?? null,
    reporter_hash: null,
    status: 'open',
    created_at: new Date().toISOString(),
  });
  return ok({ id }, 201);
});

adminRoutes.post('/probe', async (c) => {
  const body = await readJson<{ url?: string; userAgent?: string; referer?: string }>(c);
  if (!body?.url) return fail('缺少地址');
  const result = await probeStream(body.url, {
    timeoutMs: 10_000,
    warmupBytes: 384 * 1024,
    sampleMs: 1_500,
    headers: { userAgent: body.userAgent, referer: body.referer },
  });
  return ok({ result });
});

/** Runner -> D1: discovered channels and aliases. */
adminRoutes.post('/sync/channels', async (c) => {
  const body = await readJson<{ channels?: Array<{ id: string; name: string; group: string; tvgId?: string; logo?: string; aliases?: string[] }> }>(c);
  if (!Array.isArray(body?.channels)) return fail('缺少 channels');
  const count = await upsertChannelSeeds(c.env, body.channels.slice(0, 5000));
  return ok({ synced: count });
});

/** Runner -> D1: per-source fetch/probe stats, reputation and ETag. */
adminRoutes.post('/sync/sources', async (c) => {
  const body = await readJson<{ stats?: Parameters<typeof applySourceStats>[1] }>(c);
  if (!Array.isArray(body?.stats)) return fail('缺少 stats');
  await applySourceStats(c.env, body.stats);
  return ok({ synced: body.stats.length });
});

adminRoutes.get('/catalog', async (c) => {
  const catalog = await loadCatalog(c.env);
  if (!catalog) return fail('尚未生成频道数据', 409);
  return ok({
    runId: catalog.runId,
    generatedAt: catalog.generatedAt,
    channels: catalog.items.length,
    lines: catalog.items.reduce((sum, item) => sum + item.lines.length, 0),
  });
});

interface ProbeLine {
  key: string;
  name?: string;
  channelId: string;
  channelName: string;
  group: string;
  sourceId: string;
  status: string;
  resolution: string | null;
  speedKbps: number;
  latencyMs: number;
  protocol: string;
  failCount: number;
  score: number;
  lastProbeAt: string | null;
  url: string;
  sourceName?: string;
  sourceSite?: string;
}

adminRoutes.get('/lines', async (c) => {
  const data = await getJson<{ generatedAt: string; items: ProbeLine[] }>(c.env, 'state/probe.json');
  const catalog = await loadCatalog(c.env);
  let sourceItems: ProbeLine[];
  let generatedAt: string;

  if (data) {
    sourceItems = data.items;
    generatedAt = data.generatedAt;
  } else {
    // Fallback: the catalog is enough to show resolution/speed before the next
    // publish writes state/probe.json.
    if (!catalog) return ok({ ready: false, items: [], summary: null });
    generatedAt = catalog.generatedAt;
    sourceItems = catalog.items.flatMap((item) =>
      item.lines.map((line) => ({
        key: line.key,
        name: line.name,
        channelId: item.channel.id,
        channelName: item.channel.name,
        group: item.channel.group,
        sourceId: line.sourceId,
        status: line.status,
        resolution: line.resolution ?? null,
        speedKbps: line.speedKbps ?? 0,
        latencyMs: line.latencyMs ?? 0,
        protocol: line.protocol,
        failCount: line.failCount,
        score: line.score,
        lastProbeAt: line.lastProbeAt ?? null,
        url: line.url,
      })),
    );
  }

  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const status = c.req.query('status') ?? '';
  const sourceId = c.req.query('sourceId') ?? '';
  const resolution = c.req.query('resolution') ?? '';
  const minSpeed = Number(c.req.query('minSpeed') ?? '0') || 0;
  const limit = Math.min(Number(c.req.query('limit') ?? 200) || 200, 500);

  const nameByKey = new Map(catalog?.items.flatMap((item) => item.lines.map((line) => [line.key, line.name])) ?? []);
  const normalized = sourceItems.map((row) => ({
    ...row,
    name: row.name ?? nameByKey.get(row.key),
    // Clamp historical burst measurements until the next probe rewrites them.
    speedKbps: Math.min(row.speedKbps || 0, 50_000),
    // Prefer measured dimensions; otherwise parse 720p/1080p/480p from the
    // channel name, the line label or the URL path.
    resolution: row.resolution || inferResolution(`${row.name ?? nameByKey.get(row.key) ?? ''} ${row.channelName} ${row.url}`) || null,
  }));
  let rows = normalized;
  const summary = {
    generatedAt,
    total: rows.length,
    alive: rows.filter((row) => row.status === 'alive').length,
    suspect: rows.filter((row) => row.status === 'suspect').length,
    dead: rows.filter((row) => row.status === 'dead').length,
    unknown: rows.filter((row) => row.status === 'unknown').length,
    avgSpeedKbps: rows.length ? Math.round(rows.reduce((sum, row) => sum + (row.speedKbps || 0), 0) / rows.length) : 0,
    resolutions: rows.reduce<Record<string, number>>((acc, row) => {
      const key = row.resolution ?? '未知';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
    protocols: rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.protocol] = (acc[row.protocol] ?? 0) + 1;
      return acc;
    }, {}),
  };

  if (q) rows = rows.filter((row) => row.channelName.toLowerCase().includes(q) || row.sourceId.includes(q) || row.url.toLowerCase().includes(q));
  if (status) rows = rows.filter((row) => row.status === status);
  if (sourceId) rows = rows.filter((row) => row.sourceId === sourceId);
  if (resolution) rows = rows.filter((row) => (row.resolution ?? '未知') === resolution);
  if (minSpeed > 0) rows = rows.filter((row) => row.speedKbps >= minSpeed);

  rows = [...rows].sort((a, b) => {
    const rank = (value: string): number => (value === 'alive' ? 0 : value === 'suspect' ? 1 : value === 'unknown' ? 2 : 3);
    return rank(a.status) - rank(b.status) || b.speedKbps - a.speedKbps;
  });

  const meta = sourceMetaMap(await listSources(c.env));
  const items = rows.slice(0, limit).map((row) => ({
    ...row,
    sourceName: meta.get(row.sourceId)?.name ?? row.sourceId,
    sourceSite: meta.get(row.sourceId)?.site ?? '未知来源',
  }));

  return ok({ ready: true, summary, total: rows.length, items });
});

adminRoutes.get('/channel/:id', async (c) => {
  const channel = await getChannel(c.env, c.req.param('id'));
  if (!channel) return fail('频道不存在', 404);
  return ok({ channel });
});

// ---------------------------------------------------------------- artifacts
// The runner uploads every artifact through these endpoints, so GitHub Actions
// never needs R2/S3 credentials — only API_BASE_URL + ADMIN_TOKEN.

function artifactKey(path: string): string {
  return decodeURIComponent(path.replace(/^.*\/api\/admin\/artifacts\//, ''));
}

adminRoutes.get('/artifacts', async (c) => {
  const prefix = c.req.query('prefix') ?? '';
  const items = await listArtifacts(c.env, prefix, Math.min(Number(c.req.query('limit') ?? 100), 1000));
  return ok({ items });
});

adminRoutes.get('/artifacts/*', async (c) => {
  const key = artifactKey(c.req.path);
  if (!key) return fail('缺少 key');
  const text = await getText(c.env, key);
  if (text === null) return fail('产物不存在', 404);
  return new Response(text, {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
});

adminRoutes.put('/artifacts/*', async (c) => {
  const key = artifactKey(c.req.path);
  if (!key) return fail('缺少 key');
  const contentType = c.req.query('type') ?? c.req.header('content-type') ?? 'application/octet-stream';
  const body = await c.req.arrayBuffer();
  if (body.byteLength > 24 * 1024 * 1024) return fail('产物超过 KV 单值 24MB 限制', 413);
  const meta = await putArtifact(c.env, key, body, contentType);
  return ok({ key, size: meta.size, etag: meta.etag });
});

adminRoutes.delete('/artifacts/*', async (c) => {
  const key = artifactKey(c.req.path);
  if (!key) return fail('缺少 key');
  await c.env.KV.delete(key);
  return ok({ ok: true });
});
