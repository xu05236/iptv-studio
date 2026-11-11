import { Hono } from 'hono';
import { classifyGroup, compileRules, displayName, mapPool, probeLiveness, probeStream, activeProbeProfile, type AppSettings, type LineEntry, type Rule } from '@iptv/core';
import type { AppEnv } from '../env.js';
import {
  applySourceStats,
  audit,
  countOpenFeedback,
  deleteRule,
  getRun,
  insertFeedback,
  getFeedback,
  listAudit,
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
import { getText, getJson, listArtifacts, putArtifact } from '../lib/store.js';
import { loadLines, saveLines } from '../lib/linesState.js';
import { LINES_SHARD_COUNT, lineShardKey } from '@iptv/core';
import { getRuntimeJson } from '../lib/runtime-state.js';
import { putRuntimeJson } from '../lib/runtime-state.js';
import { clearSnapshots, createSnapshot } from '../lib/snapshots.js';
import { inferResolution } from '@iptv/core';
import { dispatchWorkflow, workflowRunStatus } from '../lib/github.js';
import { createTask, deleteFailedTasks, dispatchNext, finishTask, loadTasks, mutateTask, progressTask, recordFinishedTask, type Task } from '../lib/tasks.js';
import { registerTelegramWebhook } from '../lib/telegram.js';
import { loadCatalog, loadGuide, loadIndex } from '../lib/catalog.js';
import { describeAfterProbeGate, nextAutoCollectAt, nextAutoLivenessAt, nextAutoPublishAt, nextDueFetchSlot, nextScheduledAt, parseCollectTimes } from '../lib/schedule.js';
import { sourceMetaMap } from '../lib/source.js';
import { summarizeCoverage, type GuideLike } from '../lib/epgCoverage.js';
import { MIGRATION_FILES } from '../lib/migrations.generated.js';

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.get('/storage/sizes', async (c) => {
  const keys = [
    'state/lines-manifest.json',
    ...Array.from({ length: LINES_SHARD_COUNT }, (_, index) => lineShardKey(index)),
    'state/lines-archive.json',
    'state/probe.json',
    'state/line-index.json',
    'state/index.json',
    'out/catalog.json',
    'state/guide.json',
    'state/now.json',
    'state/pool.json',
    'state/pool-stats.json',
    'out/epg.xml',
    'state/epg-unmatched.json',
  ];
  const items: Array<{ key: string; bytes: number }> = [];
  for (const key of keys) {
    const value = await c.env.KV.get(key);
    items.push({ key, bytes: value ? new TextEncoder().encode(value).length : 0 });
  }
  const lastPublish = await getJson<{ generatedAt?: string; items?: Array<{ key: string; bytes: number }> }>(c.env, 'state/publish-sizes.json');
  return ok({
    items,
    totalBytes: items.reduce((sum, item) => sum + item.bytes, 0),
    thresholds: { warnMb: 15, blockMb: 22 },
    lastPublish: lastPublish ?? null,
  });
});

adminRoutes.get('/db/migrations', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>();
  const applied = results.map((row) => row.name);
  const expected = [...MIGRATION_FILES];
  const missing = expected.filter((name) => !applied.includes(name));
  const extra = applied.filter((name) => !expected.includes(name));
  return ok({
    applied: applied.length,
    expected: expected.length,
    ok: missing.length === 0 && extra.length === 0,
    missing,
    extra,
    last: applied.at(-1) ?? null,
  });
});

adminRoutes.get('/epg/coverage', async (c) => {
  const [index, guide] = await Promise.all([loadIndex(c.env), loadGuide(c.env)]);
  if (!index) return ok({ total: 0, covered: 0, percent: 0, missing: [], missingTotal: 0, filteredTotal: 0, offset: 0, limit: 100 });
  const summary = summarizeCoverage(index.channels.map((channel) => channel.id), guide as GuideLike | null);
  const channelById = new Map(index.channels.map((channel) => [channel.id, channel]));
  const missing = summary.missingIds.map((id) => channelById.get(id)).filter((channel): channel is NonNullable<typeof channel> => Boolean(channel));
  const staleChannels = summary.staleIds.map((id) => channelById.get(id)).filter((channel): channel is NonNullable<typeof channel> => Boolean(channel));
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const group = (c.req.query('group') ?? '').trim();
  const filtered = missing.filter((channel) => {
    if (group && (channel.group || '其他') !== group) return false;
    if (!q) return true;
    return `${channel.name} ${channel.id} ${channel.group}`.toLowerCase().includes(q);
  });
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0);
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 100) || 100));
  return ok({
    total: summary.total,
    covered: summary.covered,
    coveredAny: summary.coveredAny,
    stale: summary.stale,
    percent: summary.percent,
    guideGeneratedAt: (guide as GuideLike | null)?.generatedAt ?? null,
    guideAgeHours: summary.guideAgeHours,
    guideStale: summary.guideStale,
    guideHours: (guide as GuideLike | null)?.hours ?? null,
    missing: filtered.slice(offset, offset + limit).map((channel) => ({ id: channel.id, name: channel.name, group: channel.group })),
    staleChannels: staleChannels.slice(0, 100).map((channel) => ({ id: channel.id, name: channel.name })),
    missingTotal: filtered.length,
    filteredTotal: filtered.length,
    allMissing: missing.length,
    offset,
    limit,
  });
});

adminRoutes.get('/epg/sources', async (c) => {
  const report = await getJson<{ generatedAt?: string; items?: unknown[] }>(c.env, 'state/epg-sources.json');
  return ok({ generatedAt: report?.generatedAt ?? null, items: report?.items ?? [] });
});

adminRoutes.get('/epg/unmatched', async (c) => {
  const [report, channels] = await Promise.all([
    getJson<{ generatedAt?: string; items?: Array<{ epgName: string; provider: string; channelId: string; confidence: number }> }>(
      c.env,
      'state/epg-unmatched.json',
    ),
    listChannels(c.env),
  ]);
  return ok({
    generatedAt: report?.generatedAt ?? null,
    items: report?.items ?? [],
    channels: channels.map((channel) => ({ id: channel.id, name: channel.name, group: channel.group_title })),
  });
});

adminRoutes.post('/epg/clean-noise', async (c) => {
  const [state, channels] = await Promise.all([
    loadLines(c.env),
    listChannels(c.env),
  ]);
  const live = new Set((state?.lines ?? []).map((line) => line.channelId));
  const noise = channels.filter((channel) => channel.id.startsWith('x-') && !live.has(channel.id));
  for (let index = 0; index < noise.length; index += 40) {
    await c.env.DB.batch(noise.slice(index, index + 40).map((channel) => c.env.DB.prepare('DELETE FROM channels WHERE id = ?').bind(channel.id)));
  }
  await audit(c.env, c.get('actor'), 'epg.clean_noise', String(noise.length));
  return ok({ removed: noise.length });
});

adminRoutes.post('/recover/lines-from-pool', async (c) => {
  // Emergency recovery after a bad write wiped the sharded line state: the
  // pool snapshot still holds every line that was alive at its generatedAt
  // (url, channel, probe status). Rebuild lines.json from it without touching
  // the pool/guide/catalog artifacts so subscriptions keep rendering.
  const pool = await getJson<{ generatedAt?: string; channels?: Record<string, { premium?: LineEntry[]; backup?: LineEntry[]; candidate?: LineEntry[] }> }>(c.env, 'state/pool.json');
  if (!pool?.channels) return fail('没有可用的线路池快照（state/pool.json）', 404);
  const byKey = new Map<string, LineEntry>();
  for (const entry of Object.values(pool.channels)) {
    for (const bucket of ['premium', 'backup', 'candidate'] as const) {
      for (const line of entry[bucket] ?? []) {
        if (line?.key) byKey.set(line.key, line);
      }
    }
  }
  if (!byKey.size) return fail('池快照里没有线路', 400);
  let existing: { lines: LineEntry[] };
  try {
    existing = await loadLines(c.env);
  } catch (error) {
    // Never recover on top of an unreadable state: the old catch-all produced
    // { lines: [] } and the save below then replaced every non-pool line.
    const message = error instanceof Error ? error.message : String(error);
    return fail(`读取现有线路失败，已中止恢复（未写入）：${message}`, 500);
  }
  for (const line of existing.lines) {
    if (line?.key && !byKey.has(line.key)) byKey.set(line.key, line);
  }
  const lines = [...byKey.values()];
  const generatedAt = pool.generatedAt ?? new Date().toISOString();
  await saveLines(c.env, lines, generatedAt);
  await audit(c.env, c.get('actor'), 'lines.recover_from_pool', 'state/pool.json', { lines: lines.length, generatedAt });
  return ok({ lines: lines.length, generatedAt });
});

/**
 * Idempotent schema guard for environments where `wrangler d1 migrations` is
 * not available (no Cloudflare API token on the dev machine). Safe to call
 * repeatedly; the canonical DDL lives in migrations/0012_line_tombstones.sql.
 */
adminRoutes.post('/db/ensure-tombstones', async (c) => {
  await c.env.DB.batch([
    c.env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS line_tombstones (
        url TEXT PRIMARY KEY,
        line_key TEXT,
        channel_id TEXT,
        reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    ),
    c.env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_line_tombstones_created ON line_tombstones(created_at)'),
  ]);
  await audit(c.env, c.get('actor'), 'db.ensure_tombstones', 'schema');
  return ok({ ok: true });
});

/**
 * Batch-bind EPG aliases. The workbench usually fills several channels from one
 * group at a time; doing one POST per row was slow and noisy.
 */
adminRoutes.post('/epg/bind-bulk', async (c) => {
  const body = await readJson<{ items?: Array<{ channelId?: string; alias?: string }> }>(c);
  const items = (Array.isArray(body?.items) ? body.items : [])
    .map((item) => ({ channelId: String(item?.channelId ?? '').trim(), alias: String(item?.alias ?? '').trim() }))
    .filter((item) => item.channelId && item.alias)
    .slice(0, 500);
  if (!items.length) return fail('没有可绑定的条目');

  const ids = [...new Set(items.map((item) => item.channelId))];
  const aliases = [...new Set(items.map((item) => item.alias))];
  const [channelRows, aliasRows] = await Promise.all([
    c.env.DB.prepare(`SELECT id FROM channels WHERE id IN (${ids.map(() => '?').join(', ')})`).bind(...ids).all<{ id: string }>(),
    c.env.DB.prepare(`SELECT alias, channel_id FROM aliases WHERE alias IN (${aliases.map(() => '?').join(', ')})`).bind(...aliases).all<{ alias: string; channel_id: string }>(),
  ]);
  const knownChannels = new Set(channelRows.results.map((row) => row.id));
  const aliasOwner = new Map(aliasRows.results.map((row) => [row.alias, row.channel_id]));

  const statements: D1PreparedStatement[] = [];
  const failed: Array<{ channelId: string; alias: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!knownChannels.has(item.channelId)) {
      failed.push({ ...item, reason: '频道不存在' });
      continue;
    }
    const owner = aliasOwner.get(item.alias);
    if (owner && owner !== item.channelId) {
      failed.push({ ...item, reason: `别名已属于 ${owner}` });
      continue;
    }
    if (owner === item.channelId || seen.has(item.alias)) continue;
    seen.add(item.alias);
    statements.push(c.env.DB.prepare('INSERT OR IGNORE INTO aliases (alias, channel_id) VALUES (?, ?)').bind(item.alias, item.channelId));
  }
  for (let offset = 0; offset < statements.length; offset += 40) {
    await c.env.DB.batch(statements.slice(offset, offset + 40));
  }
  await audit(c.env, c.get('actor'), 'epg.bind_bulk', 'channels', { bound: statements.length, failed: failed.length });
  return ok({ bound: statements.length, failed });
});

adminRoutes.get('/backup', async (c) => {
  const [sources, channels, subscriptions, settings] = await Promise.all([
    listSources(c.env),
    listChannels(c.env),
    listSubscriptions(c.env),
    loadSettings(c.env),
  ]);
  const { results: aliases } = await c.env.DB.prepare('SELECT alias, channel_id FROM aliases ORDER BY channel_id, alias').all<{
    alias: string;
    channel_id: string;
  }>();
  return ok({
    exportedAt: new Date().toISOString(),
    version: 1,
    settings,
    sources,
    channels,
    aliases,
    subscriptions,
  });
});

adminRoutes.get('/stats', async (c) => {
  const [index, sources, channels, subscriptions, feedbackOpen, runs, pool, tasks] = await Promise.all([
    loadIndex(c.env),
    listSources(c.env),
    listChannels(c.env),
    listSubscriptions(c.env),
    countOpenFeedback(c.env),
    listRuns(c.env, 5),
    getJson<Record<string, number>>(c.env, 'state/pool-stats.json'),
    loadTasks(c.env),
  ]);

  const reputation = { high: 0, normal: 0, low: 0 };
  const sourceNames = new Map(sources.map((source) => [source.id, source.name]));
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
    pool: {
      total: Number(pool?.total ?? 0),
      alive: Number(pool?.alive ?? 0),
      pending: Number(pool?.pending ?? 0),
      quarantine: Number(pool?.quarantine ?? 0),
      generatedAt: pool?.generatedAt ?? null,
    },
    runs: runs.map((run) => {
      const task = run.task_id ? tasks.find((item) => item.id === run.task_id) : undefined;
      return {
        ...run,
        task_type: task?.type ?? null,
        task_source: task?.source ?? null,
        task_message: task?.message ?? null,
        task_label: task ? describeTask(task, sourceNames) : null,
      };
    }),
  });
});

adminRoutes.get('/runs', async (c) => {
  const limit = Math.max(1, Math.min(Number(c.req.query('limit') ?? 20), 100));
  const [runs, tasks, sourceRows] = await Promise.all([listRuns(c.env, limit), loadTasks(c.env), listSources(c.env)]);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const sourceNames = new Map(sourceRows.map((row) => [row.id, row.name]));
  return ok({
    items: runs.map((run) => {
      const task = run.task_id ? taskById.get(run.task_id) : undefined;
      return {
        ...run,
        task_type: task?.type ?? null,
        task_source: task?.source ?? null,
        task_message: task?.message ?? null,
        task_label: task ? describeTask(task, sourceNames) : null,
        task_failure_reason: run.status === 'failed' ? run.error ?? null : null,
        warnings: parseJsonField<string[]>(run.warnings, []),
      };
    }),
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
  const body = (await readJson<{ command?: string; force?: boolean; budget?: number | string; sourceId?: string; lineKeys?: string[] | string; phase?: string; source?: string }>(c)) ?? {};
  const allowedCommands = new Set(['collect', 'export', 'epg', 'fetch', 'probe', 'probe-batch', 'publish', 'liveness', 'probe-lines', 'cleanup-orphans', 'cleanup-rejected', 'revive-batch', 'rules-preview']);
  const requestedCommand = body.command ?? '';
  const command = allowedCommands.has(requestedCommand) ? requestedCommand : 'collect';
  const force = Boolean(body.force);
  const settings = await loadSettings(c.env);
  const defaultBudget = force ? Math.max(6000, settings.probeBudget || 1200) : settings.probeBudget || 1200;

  // Hard guard against accidentally crossing the daily KV write quota.
  const usage = await getRuntimeJson<{ kv?: { day?: string; writes?: number }; d1?: { day?: string; rowsWritten?: number } }>(c.env, 'state/usage.json');
  const today = new Date().toISOString().slice(0, 10);
  const kvWrites = usage?.kv?.day === today ? Number(usage.kv.writes ?? 0) : 0;
  if (kvWrites >= 920) {
    await audit(c.env, c.get('actor'), 'run.dispatch_blocked', 'kv-quota', { kvWrites });
    return fail(`KV 今日已写入 ${kvWrites}/1000，已暂停触发采集/导出，避免发布失败。请等 UTC 00:00 额度重置。`, 429, 'kv_quota');
  }
  const d1Writes = usage?.d1?.day === today ? Number(usage.d1.rowsWritten ?? 0) : 0;
  if (d1Writes >= 90_000) {
    await audit(c.env, c.get('actor'), 'run.dispatch_blocked', 'd1-quota', { d1Writes });
    return fail(`D1 今日已写入 ${d1Writes}/100000 行，已暂停触发任务。请等 UTC 00:00 额度重置。`, 429, 'd1_quota');
  }

  // GitHub rejects any input that is not declared in the workflow file, so only
  // send the keys collect.yml actually defines.
  const lineKeys = Array.isArray(body.lineKeys)
    ? body.lineKeys.filter((key): key is string => typeof key === 'string').slice(0, 50)
    : typeof body.lineKeys === 'string'
      ? body.lineKeys.split(/[\s,]+/).filter(Boolean).slice(0, 50)
      : [];
  const source = ['manual', 'detection', 'source', 'cli'].includes(body.source ?? '') ? body.source! : 'manual';
  // A manual collect/fetch means "refresh now": ignore the per-source refresh
  // interval. Scheduled runs stay incremental. Probing keeps its own TTL.
  const forceFetch = (command === 'collect' || command === 'fetch') && source === 'manual';
  const task = await createTask(c.env, {
    type: command,
    source: source as 'manual' | 'detection' | 'source' | 'cli',
    priority: source === 'source' ? 80 : 100,
    payload: {
      force: force ? 'true' : 'false',
      force_fetch: forceFetch ? 'true' : 'false',
      budget: String(body.budget ?? defaultBudget),
      source_id: body.sourceId?.trim() ?? '',
      line_keys: lineKeys.join(','),
      phase: typeof body.phase === 'string' && ['pending', 'quarantine'].includes(body.phase) ? body.phase : '',
    },
    total: command === 'probe-batch' ? Math.max(0, activeProbeProfile(settings).batchSize) : 0,
    unit: command === 'probe-batch' ? 'lines' : '',
    message: source === 'detection' ? '检测中心发起' : undefined,
  });
  const dispatched = await dispatchNext(c.env);
  await audit(c.env, c.get('actor'), 'run.dispatch', task.id, { command, source, message: dispatched.message });
  const started = dispatched.task?.id === task.id && dispatched.task.status === 'running';
  return ok({
    ok: true,
    message: started ? '任务已开始' : '任务已加入队列',
    taskId: task.id,
    kvWrites,
    warning: kvWrites >= 850 ? `KV 今日已写入 ${kvWrites}/1000，接近上限` : undefined,
  }, 202);
});

/** Runner callbacks: persist the run summary (artifacts already live in R2). */
adminRoutes.post('/runs', async (c) => {
  const report = await readJson<Record<string, unknown>>(c);
  if (!report || !report['id']) return fail('缺少运行 ID');
  await upsertRun(c.env, report as never);
  if (typeof report['taskId'] === 'string') {
    const failed = report['status'] === 'failed';
    const message = failed
      ? (typeof report['error'] === 'string' ? report['error'] : undefined)
      : (typeof report['message'] === 'string' ? report['message'] : undefined);
    await finishTask(c.env, report['taskId'], failed ? 'failed' : 'done', message);
    // Start the next queued/retried task immediately instead of waiting up to
    // five minutes for the next scheduler tick.
    await dispatchNext(c.env);
  }
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

adminRoutes.get('/rules/preview-report', async (c) => {
  const report = await getJson<Record<string, unknown>>(c.env, 'state/rules-preview.json');
  return ok({ report: report ?? null });
});

adminRoutes.post('/rules/preview', async (c) => {
  const body = await readJson<{ names?: string[] }>(c);
  const names = (Array.isArray(body?.names) ? body.names : [])
    .map((name) => String(name).trim())
    .filter(Boolean)
    .slice(0, 100);
  if (!names.length) return fail('请先粘贴频道名，每行一个');
  const rows = await listRules(c.env);
  const rules: Rule[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    priority: row.priority,
    match: parseJsonField<{ match?: Rule['match']; actions?: Rule['actions'] }>(row.spec, {}).match ?? {},
    actions: parseJsonField<{ match?: Rule['match']; actions?: Rule['actions'] }>(row.spec, {}).actions ?? {},
  }));
  const compiled = compileRules(rules);
  const items = names.map((input, index) => {
    const name = displayName(input);
    const group = classifyGroup(input);
    const channel = { id: `preview-${index}`, name, group, tvgId: undefined };
    const line = {
      name: input,
      url: 'http://preview.invalid/live.m3u8',
      protocol: 'hls' as const,
      resolution: 'unknown' as const,
      speedKbps: 0,
      sourceId: 'preview',
      tags: [] as string[],
      status: 'unknown' as const,
    };
    const matched = compiled.filter((rule) => rule.matches({ channel, line })).map((rule) => rule.rule.id);
    return { input, name, group, matched };
  });
  return ok({ items, rules: rules.map((rule) => ({ id: rule.id, name: rule.name, enabled: rule.enabled })) });
});

adminRoutes.delete('/rules/:id', async (c) => {
  await deleteRule(c.env, c.req.param('id'));
  return ok({ ok: true });
});

adminRoutes.get('/snapshots', async (c) => {
  const manifest = await getJson<{ items: unknown[] }>(c.env, 'state/snapshots.json');
  return ok({ items: manifest?.items ?? [] });
});

adminRoutes.post('/snapshots', async (c) => {
  const body = (await readJson<{ origin?: string }>(c)) ?? {};
  const origin = body.origin === 'publish' ? 'publish' : 'manual';
  const item = await createSnapshot(c.env, c.get('actor'));
  if (!item) return fail('当前没有可快照的发布产物', 404);
  await recordFinishedTask(c.env, {
    type: 'snapshot',
    source: origin === 'publish' ? 'source' : 'manual',
    message: `快照完成 · ${item.channels} 频道 · ${item.lines} 行 · ${item.alive} 可用`,
    payload: { origin },
  });
  await audit(c.env, c.get('actor'), 'snapshot.create', item.id);
  return ok({ item });
});

adminRoutes.delete('/snapshots', async (c) => {
  const removed = await clearSnapshots(c.env);
  await recordFinishedTask(c.env, {
    type: 'snapshot',
    source: 'manual',
    message: `快照清理完成 · 删除 ${removed} 个`,
    payload: { origin: 'clear' },
  });
  await audit(c.env, c.get('actor'), 'snapshot.clear', 'all', { removed });
  return ok({ removed });
});

adminRoutes.post('/snapshots/:id/restore', async (c) => {
  const id = c.req.param('id');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) return fail('快照 ID 不合法', 400);
  const base = `state/snapshots/${id}`;
  const [index, catalog, pool, guide] = await Promise.all([
    getJson<unknown>(c.env, `${base}/index.json`),
    getJson<unknown>(c.env, `${base}/catalog.json`),
    getJson<unknown>(c.env, `${base}/pool.json`),
    getJson<unknown>(c.env, `${base}/guide.json`),
  ]);
  if (!index || !catalog) return fail('快照不存在或已过期', 404);
  const json = 'application/json; charset=utf-8';
  await putArtifact(c.env, 'state/index.json', JSON.stringify(index), json);
  await putArtifact(c.env, 'out/catalog.json', JSON.stringify(catalog), json);
  if (pool) await putArtifact(c.env, 'state/pool.json', JSON.stringify(pool), json);
  if (guide) await putArtifact(c.env, 'state/guide.json', JSON.stringify(guide), json);
  await recordFinishedTask(c.env, {
    type: 'snapshot',
    source: 'manual',
    message: `快照回滚完成 · ${id}`,
    payload: { origin: 'restore' },
  });
  await audit(c.env, c.get('actor'), 'snapshot.restore', id);
  return ok({ ok: true });
});

adminRoutes.post('/db/clean-logo-names', async (c) => {
  const result = await c.env.DB.prepare(
    "UPDATE channels SET logo = NULL WHERE logo IS NOT NULL AND logo NOT LIKE 'http%'",
  ).run();
  const cleaned = Number((result.meta as { changes?: number }).changes ?? 0);
  await audit(c.env, c.get('actor'), 'db.clean_logo_names', 'channels', { cleaned });
  return ok({ cleaned });
});

adminRoutes.get('/notify/chats', async (c) => {
  const token = c.env.TELEGRAM_BOT_TOKEN;
  if (!token) return fail('未配置 TELEGRAM_BOT_TOKEN', 400);
  const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, { method: 'GET' });
  const result = (await response.json()) as { ok?: boolean; description?: string; result?: Array<{ message?: { chat?: { id: number; type: string; username?: string; title?: string; first_name?: string } } }> };
  if (!result.ok) return fail(`Telegram 返回：${result.description ?? response.status}`, 502);
  const chats = new Map<number, { id: number; type: string; name?: string }>();
  for (const update of result.result ?? []) {
    const chat = update.message?.chat;
    if (chat) chats.set(chat.id, { id: chat.id, type: chat.type, name: chat.title ?? chat.first_name ?? chat.username });
  }
  return ok({ chats: [...chats.values()] });
});

adminRoutes.post('/notify/webhook', async (c) => {
  try {
    return ok(await registerTelegramWebhook(c.env));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), 502);
  }
});

adminRoutes.post('/notify/test', async (c) => {
  const token = c.env.TELEGRAM_BOT_TOKEN;
  const chatId = c.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return fail('未配置 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID', 400);
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: '✅ IPTV Studio 通知测试成功' }),
  });
  const result = (await response.json()) as { ok?: boolean; description?: string };
  if (!result.ok) {
    const masked = `${String(chatId).slice(0, 3)}***${String(chatId).slice(-4)}`;
    return fail(`Telegram 返回：${result.description ?? response.status}（当前 chat ${masked}）`, 502);
  }
  return ok({ sent: true });
});

adminRoutes.post('/actions/cancel-stuck', async (c) => {
  if (!c.env.GITHUB_TOKEN || !c.env.GITHUB_REPO) return fail('未配置 GITHUB_TOKEN / GITHUB_REPO', 400);
  const headers = { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'iptv-studio' };
  const cancelled: number[] = [];
  for (const status of ['in_progress', 'queued']) {
    const response = await fetch(
      `https://api.github.com/repos/${c.env.GITHUB_REPO}/actions/workflows/collect.yml/runs?status=${status}&per_page=20`,
      { headers },
    );
    const payload = (await response.json()) as { workflow_runs?: Array<{ id: number }> };
    for (const run of payload.workflow_runs ?? []) {
      await fetch(`https://api.github.com/repos/${c.env.GITHUB_REPO}/actions/runs/${run.id}/cancel`, { method: 'POST', headers });
      cancelled.push(run.id);
    }
  }
  return ok({ cancelled });
});

adminRoutes.post('/actions/recover-stuck', async (c) => {
  let cancelled = 0;
  if (c.env.GITHUB_TOKEN && c.env.GITHUB_REPO) {
    const headers = { Authorization: `Bearer ${c.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'iptv-studio' };
    for (const status of ['in_progress', 'queued']) {
      const response = await fetch(
        `https://api.github.com/repos/${c.env.GITHUB_REPO}/actions/workflows/collect.yml/runs?status=${status}&per_page=20`,
        { headers },
      );
      const payload = (await response.json()) as { workflow_runs?: Array<{ id: number }> };
      for (const run of payload.workflow_runs ?? []) {
        const result = await fetch(`https://api.github.com/repos/${c.env.GITHUB_REPO}/actions/runs/${run.id}/cancel`, { method: 'POST', headers });
        if (result.ok) cancelled++;
      }
    }
  }
  const tasks = await loadTasks(c.env);
  const running = tasks.filter((task) => task.status === 'running');
  for (const task of running) await mutateTask(c.env, task.id, 'force-fail');
  return ok({ cancelled, failed: running.length });
});

adminRoutes.get('/settings', async (c) => {
  const settings = await loadSettings(c.env);
  return ok({ settings, publicBaseUrl: c.env.PUBLIC_BASE_URL ?? new URL(c.req.url).origin });
});

adminRoutes.put('/settings', async (c) => {
  const patch = await readJson<Partial<AppSettings>>(c);
  if (!patch) return fail('请求体不合法');
  const allowed: Array<keyof AppSettings> = [
    'logoBaseUrl', 'maxLinesPerChannel', 'frontLineLimit', 'maxLinesPerSource', 'compensate', 'keepSuspect', 'rejectedRetentionDays',
    'sourceDegradeThreshold', 'sourcePauseThreshold', 'sourceHalfOpenHours',
    'fetchTimes', 'monthlyReviveEnabled', 'monthlyReviveMinRemainingMinutes', 'monthlyReviveBatchSize',
    'probeBudget', 'concurrency', 'probeAliveHours', 'probePremiumHours', 'probePerChannel',
    'ffprobeLimit', 'probePrefilterEnabled', 'probePrefilterBudget', 'lineRetentionDays', 'epgUrls', 'regionSuffix', 'epgSourcePriority',
    'autoCollectEnabled', 'autoCollectTimes', 'autoLivenessEnabled', 'autoLivenessTimes',
    'autoProbeEnabled', 'probeBatchSize', 'autoProbeIntervalHours',
    'actionsRepoMode', 'privateProbeBatchSize', 'privateProbeIntervalHours', 'privateMaxDailyDispatches',
    'publicProbeBatchSize', 'publicProbeIntervalHours', 'publicMaxDailyDispatches',
    'actionsMonthlyBudgetMinutes', 'actionsReserveMinutes', 'actionsRunCostMinutes',
    'probePhaseOrder', 'probePausedPhases',
    'autoFetchEnabled', 'fetchIntervalDays', 'autoPublishEnabled', 'autoPublishTimes', 'autoPublishIntervalHours', 'autoPublishAfterProbeEnabled', 'epgRefreshEnabled', 'epgRefreshTimes',
    'snapshotOnPublishEnabled', 'snapshotScheduleEnabled', 'snapshotScheduleTimes',
    'notifyTelegram', 'retentionDays', 'screenshots', 'relayEnabled', 'directPlayback', 'relayDailyRequests', 'relayDailyBytes',
  ];
  const clean: Partial<AppSettings> = {};
  for (const key of allowed) {
    if (key in patch) (clean as Record<string, unknown>)[key] = patch[key];
  }
  if (clean.autoCollectTimes !== undefined) {
    const times = parseCollectTimes(clean.autoCollectTimes);
    if (!times.length) return fail('自动采集时间格式应为 HH:mm，多个用逗号分隔（北京时间）');
    clean.autoCollectTimes = times.map((time) => `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`).join(',');
  }
  if (clean.autoLivenessTimes !== undefined) {
    const times = parseCollectTimes(clean.autoLivenessTimes);
    if (!times.length) return fail('每日测活时间格式应为 HH:mm，多个用逗号分隔（北京时间）');
    clean.autoLivenessTimes = times.map((time) => `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`).join(',');
  }
  if (clean.autoPublishTimes !== undefined) {
    const times = parseCollectTimes(clean.autoPublishTimes);
    if (!times.length) return fail('每日发布时间格式应为 HH:mm（北京时间）');
    clean.autoPublishTimes = times.map((time) => `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`).join(',');
  }
  if (clean.epgRefreshTimes !== undefined) {
    const times = parseCollectTimes(clean.epgRefreshTimes);
    if (!times.length) return fail('EPG 刷新时间格式应为 HH:mm（北京时间）');
    clean.epgRefreshTimes = times.map((time) => `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`).join(',');
  }
  if (clean.snapshotScheduleTimes !== undefined) {
    const times = parseCollectTimes(clean.snapshotScheduleTimes);
    if (!times.length) return fail('快照时间格式应为 HH:mm（北京时间）');
    clean.snapshotScheduleTimes = times.map((time) => `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`).join(',');
  }
  if (clean.probeBatchSize !== undefined) clean.probeBatchSize = Math.max(1, Number(clean.probeBatchSize) || 1200);
  if (clean.autoProbeIntervalHours !== undefined) clean.autoProbeIntervalHours = Math.max(1, Number(clean.autoProbeIntervalHours) || 6);
  if (clean.actionsRepoMode !== undefined) clean.actionsRepoMode = clean.actionsRepoMode === 'public' ? 'public' : 'private';
  for (const key of ['privateProbeBatchSize', 'publicProbeBatchSize'] as const) {
    if (clean[key] !== undefined) clean[key] = Math.max(1, Math.min(20_000, Number(clean[key]) || 1200));
  }
  for (const key of ['privateProbeIntervalHours', 'publicProbeIntervalHours'] as const) {
    if (clean[key] !== undefined) clean[key] = Math.max(1, Math.min(168, Number(clean[key]) || 8));
  }
  for (const key of ['privateMaxDailyDispatches', 'publicMaxDailyDispatches'] as const) {
    if (clean[key] !== undefined) clean[key] = Math.max(1, Math.min(100, Number(clean[key]) || 20));
  }
  if (clean.actionsMonthlyBudgetMinutes !== undefined) clean.actionsMonthlyBudgetMinutes = Math.max(300, Math.min(100_000, Number(clean.actionsMonthlyBudgetMinutes) || 2_000));
  if (clean.actionsReserveMinutes !== undefined) clean.actionsReserveMinutes = Math.max(0, Math.min(50_000, Number(clean.actionsReserveMinutes) || 0));
  if (clean.actionsRunCostMinutes !== undefined) clean.actionsRunCostMinutes = Math.max(1, Math.min(120, Number(clean.actionsRunCostMinutes) || 6));
  if (clean.rejectedRetentionDays !== undefined) clean.rejectedRetentionDays = Math.max(1, Math.min(3650, Number(clean.rejectedRetentionDays) || 30));
  if (clean.monthlyReviveMinRemainingMinutes !== undefined) clean.monthlyReviveMinRemainingMinutes = Math.max(0, Math.min(100_000, Number(clean.monthlyReviveMinRemainingMinutes) || 0));
  if (clean.monthlyReviveBatchSize !== undefined) clean.monthlyReviveBatchSize = Math.max(1, Math.min(20_000, Number(clean.monthlyReviveBatchSize) || 800));
  if (clean.fetchTimes !== undefined) {
    const times = parseCollectTimes(clean.fetchTimes);
    if (!times.length) return fail('抓取时间格式应为 HH:mm，多个用逗号分隔（北京时间）');
    clean.fetchTimes = times.map((time) => `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`).join(',');
  }
  if (clean.epgSourcePriority !== undefined) {
    const list = String(clean.epgSourcePriority ?? '')
      .split(/[,，\s]+/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 20);
    clean.epgSourcePriority = [...new Set(list)].join(',');
  }
  if (clean.sourceDegradeThreshold !== undefined) clean.sourceDegradeThreshold = Math.max(1, Math.min(10, Number(clean.sourceDegradeThreshold) || 3));
  if (clean.sourcePauseThreshold !== undefined) clean.sourcePauseThreshold = Math.max(2, Math.min(20, Number(clean.sourcePauseThreshold) || 5));
  if (clean.sourceHalfOpenHours !== undefined) clean.sourceHalfOpenHours = Math.max(1, Math.min(168, Number(clean.sourceHalfOpenHours) || 6));
  if (clean.fetchIntervalDays !== undefined) clean.fetchIntervalDays = Math.min(7, Math.max(1, Math.floor(Number(clean.fetchIntervalDays) || 1)));
  if (clean.relayDailyRequests !== undefined) clean.relayDailyRequests = Math.max(100, Math.min(1_000_000, Math.floor(Number(clean.relayDailyRequests) || 20_000)));
  if (clean.relayDailyBytes !== undefined) clean.relayDailyBytes = Math.max(10 * 1024 * 1024, Math.min(100 * 1024 ** 3, Math.floor(Number(clean.relayDailyBytes) || 2 * 1024 ** 3)));
  const settings = await saveSettings(c.env, clean);
  // Shortening the probe interval must take effect now, not after the old 8h
  // window: the scheduler stores the next run time, so rewrite it from the
  // last run using the newly saved profile.
  if (
    clean.actionsRepoMode !== undefined ||
    clean.privateProbeIntervalHours !== undefined ||
    clean.publicProbeIntervalHours !== undefined ||
    clean.privateProbeBatchSize !== undefined ||
    clean.publicProbeBatchSize !== undefined
  ) {
    const state = await getRuntimeJson<{ lastRunAt?: string; nextRunAt?: string; result?: string }>(c.env, 'state/probe-schedule.json');
    if (state?.lastRunAt) {
      const profile = activeProbeProfile(settings);
      const due = Date.parse(state.lastRunAt) + profile.intervalHours * 3_600_000;
      await putRuntimeJson(c.env, 'state/probe-schedule.json', {
        ...state,
        nextRunAt: new Date(Math.max(due, Date.now())).toISOString(),
      });
    }
  }
  return ok({ settings });
});

adminRoutes.get('/schedule', async (c) => {
  const settings = await loadSettings(c.env);
  const state = await getRuntimeJson<{ lastRunAt?: string; lastScheduledAt?: string; result?: string }>(c.env, 'state/schedule.json');
  const livenessState = await getRuntimeJson<{ lastRunAt?: string; lastScheduledAt?: string; result?: string }>(c.env, 'state/liveness-schedule.json');
  const nextAt = nextAutoCollectAt(settings);
  const nextLivenessAt = nextAutoLivenessAt(settings);
  return ok({
    enabled: settings.autoCollectEnabled,
    times: settings.autoCollectTimes,
    budget: settings.probeBudget,
    lastRunAt: state?.lastRunAt ?? null,
    lastScheduledAt: state?.lastScheduledAt ?? null,
    result: state?.result ?? null,
    nextAt: nextAt ? new Date(nextAt).toISOString() : null,
    liveness: {
      enabled: settings.autoLivenessEnabled,
      times: settings.autoLivenessTimes,
      lastRunAt: livenessState?.lastRunAt ?? null,
      lastScheduledAt: livenessState?.lastScheduledAt ?? null,
      result: livenessState?.result ?? null,
      nextAt: nextLivenessAt ? new Date(nextLivenessAt).toISOString() : null,
    },
  });
});

const TASK_PHASES = ['pending', 'quarantine'] as const;
const TASK_PHASE_LABEL: Record<string, string> = {
  pending: '待测（从未探测）',
  quarantine: '待复测（到期）',
};

function describeTask(task: Task, sourceNames: Map<string, string>): string {
  const sourceId = String(task.payload?.source_id ?? '');
  const sourceName = sourceNames.get(sourceId);
  const phase = TASK_PHASE_LABEL[String(task.payload?.phase ?? '')];
  const keyCount = String(task.payload?.line_keys ?? '').split(',').filter(Boolean).length;
  if (task.type === 'fetch') return `抓源 · ${sourceName ?? '全部启用源'}`;
  if (task.type === 'probe-batch') return `分批探测 · ${phase ?? '自动阶段'}${sourceName ? ` · ${sourceName}` : ''}`;
  if (task.type === 'probe') return `完整测速 · ${sourceName ?? '全部源'}`;
  if (task.type === 'probe-lines') return `线路复测 · ${keyCount} 条`;
  if (task.type === 'publish') return task.source === 'schedule'
    ? (task.payload?.auto ? '线路发布 · 探测后自动' : '线路发布 · 定时')
    : '线路发布 · 手动';
  if (task.type === 'epg') return 'EPG 节目单刷新';
  if (task.type === 'collect') return '完整采集 · 全部源';
  if (task.type === 'liveness') return '存活检测';
  if (task.type === 'cleanup-orphans') return '孤儿线路清理';
  if (task.type === 'snapshot') {
    return task.payload?.origin === 'publish'
      ? '快照 · 发布后自动'
      : task.payload?.origin === 'schedule'
        ? '快照 · 定时'
        : task.payload?.origin === 'restore' ? '快照 · 回滚' : task.payload?.origin === 'clear' ? '快照 · 清理' : '快照 · 手动';
  }
  return task.type;
}

/** Derived detection task board for the overview page. */
adminRoutes.get('/tasks', async (c) => {
  const settings = await loadSettings(c.env);
  const taskItems = await loadTasks(c.env);
  const [stats, probeState, fetchState, publishState, epgState, sourceRows, recentRuns] = await Promise.all([
    getJson<{ generatedAt?: string; pending?: number; quarantine?: number; rejected?: number }>(c.env, 'state/pool-stats.json'),
    getRuntimeJson<{ lastRunAt?: string; nextRunAt?: string; result?: string }>(c.env, 'state/probe-schedule.json'),
    getRuntimeJson<{ lastRunAt?: string; nextRunAt?: string; result?: string }>(c.env, 'state/fetch-schedule.json'),
    getRuntimeJson<{ lastRunAt?: string; nextRunAt?: string; result?: string }>(c.env, 'state/publish-schedule.json'),
    getRuntimeJson<{ lastRunAt?: string; nextRunAt?: string; result?: string }>(c.env, 'state/epg-schedule.json'),
    listSources(c.env),
    listRuns(c.env, 100),
  ]);
  const sourceNames = new Map(sourceRows.map((row) => [row.id, row.name]));
  const runByTask = new Map(recentRuns.filter((row) => row.task_id).map((row) => [row.task_id, row]));
  const order = String(settings.probePhaseOrder ?? '')
    .split(/[\s,，]+/)
    .map((item) => item.trim())
    .filter((item): item is typeof TASK_PHASES[number] => (TASK_PHASES as readonly string[]).includes(item));
  for (const phase of TASK_PHASES) if (!order.includes(phase)) order.push(phase);
  const paused = new Set(
    String(settings.probePausedPhases ?? '')
      .split(/[\s,，]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const batchSize = activeProbeProfile(settings).batchSize;
  const probeProfile = activeProbeProfile(settings);
  const probeNextDisplay = (() => {
    const stored = probeState?.nextRunAt ? Date.parse(probeState.nextRunAt) : null;
    const last = probeState?.lastRunAt ? Date.parse(probeState.lastRunAt) : null;
    if (!stored) return '';
    if (!last) return probeState?.nextRunAt ?? '';
    const adjusted = last + probeProfile.intervalHours * 3_600_000;
    return new Date(Math.min(stored, Math.max(adjusted, Date.now()))).toISOString();
  })();
  const phases = order.map((id) => {
    const count = Math.max(0, Number(stats?.[id] ?? 0));
    return {
      id,
      label: TASK_PHASE_LABEL[id] ?? id,
      count,
      estimatedBatches: count > 0 ? Math.ceil(count / batchSize) : 0,
      paused: paused.has(id),
    };
  });
  const nextPublish = nextAutoPublishAt(settings);
  const nextEpg = nextScheduledAt(parseCollectTimes(settings.epgRefreshTimes), Date.now());
  const scheduledAt = new Date().toISOString();
  const detailedTasks = taskItems.map((task) => {
    const run = runByTask.get(task.id);
    return {
      ...task,
      label: describeTask(task, sourceNames),
      failureReason: task.status === 'failed' ? run?.error ?? task.message ?? null : null,
    };
  });
  const scheduledItems: Array<Record<string, unknown>> = [];
  if (settings.autoFetchEnabled) {
    scheduledItems.push({ id: 'scheduled-fetch', type: 'fetch', label: '抓源 · 全部启用源', source: 'schedule', status: 'scheduled', priority: 50, payload: { nextAt: fetchState?.nextRunAt ?? '' }, progress: { done: 0, total: 0, unit: '' }, createdAt: scheduledAt });
  }
  if (settings.autoPublishEnabled) {
    scheduledItems.push({ id: 'scheduled-publish', type: 'publish', label: '线路发布 · 定时', source: 'schedule', status: 'scheduled', priority: 50, payload: { nextAt: nextPublish ? new Date(nextPublish).toISOString() : '' }, progress: { done: 0, total: 0, unit: '' }, createdAt: scheduledAt });
  }
  if (settings.autoPublishAfterProbeEnabled) {
    const interval = Math.max(1, Number(settings.autoPublishIntervalHours) || 6);
    const afterProbeGate = await describeAfterProbeGate(c.env, settings);
    scheduledItems.push({
      id: 'policy-publish-after-probe',
      type: 'publish',
      label: '线路发布 · 探测后自动',
      source: 'schedule',
      status: 'scheduled',
      priority: 40,
      payload: {
        afterProbe: 'true',
        intervalHours: interval,
        lastRunAt: publishState?.lastRunAt ?? '',
        gate: afterProbeGate.ok ? '' : afterProbeGate.reason,
      },
      progress: { done: 0, total: 0, unit: '' },
      createdAt: scheduledAt,
    });
  }
  if (settings.autoProbeEnabled) {
    scheduledItems.push({ id: 'scheduled-probe', type: 'probe-batch', label: '分批探测 · 自动', source: 'schedule', status: 'scheduled', priority: 50, payload: { nextAt: probeNextDisplay, lastRunAt: probeState?.lastRunAt ?? '', result: probeState?.result ?? '' }, progress: { done: 0, total: batchSize, unit: 'lines' }, createdAt: scheduledAt });
  }
  if (settings.snapshotOnPublishEnabled) {
    scheduledItems.push({ id: 'policy-snapshot-on-publish', type: 'snapshot', label: '快照 · 发布后自动', source: 'schedule', status: 'scheduled', priority: 50, payload: { afterPublish: 'true' }, progress: { done: 0, total: 0, unit: '' }, createdAt: scheduledAt });
  }
  if (settings.epgRefreshEnabled) {
    scheduledItems.push({ id: 'scheduled-epg', type: 'epg', label: 'EPG 节目单刷新', source: 'schedule', status: 'scheduled', priority: 50, payload: { nextAt: nextEpg ? new Date(nextEpg).toISOString() : '' }, progress: { done: 0, total: 0, unit: '' }, createdAt: scheduledAt });
  }
  if (settings.snapshotScheduleEnabled) {
    const nextSnapshot = nextScheduledAt(parseCollectTimes(settings.snapshotScheduleTimes), Date.now());
    scheduledItems.push({ id: 'scheduled-snapshot', type: 'snapshot', label: '快照 · 定时', source: 'schedule', status: 'scheduled', priority: 50, payload: { nextAt: nextSnapshot ? new Date(nextSnapshot).toISOString() : '' }, progress: { done: 0, total: 0, unit: '' }, createdAt: scheduledAt });
  }
  return ok({
    batchSize,
    intervalHours: activeProbeProfile(settings).intervalHours,
    phases,
    stats: stats ?? null,
    statsGeneratedAt: stats?.generatedAt ?? null,
    items: [...detailedTasks, ...scheduledItems],
    schedules: {
      probe: {
        enabled: settings.autoProbeEnabled,
        nextAt: probeState?.nextRunAt ?? null,
        lastRunAt: probeState?.lastRunAt ?? null,
        result: probeState?.result ?? null,
      },
      fetch: {
        enabled: settings.autoFetchEnabled,
        intervalDays: settings.fetchIntervalDays,
        nextAt: (() => {
          const value = nextDueFetchSlot(parseCollectTimes(settings.fetchTimes || '06:30'), fetchState?.lastRunAt ?? null, settings.fetchIntervalDays, Date.now());
          return value ? new Date(value).toISOString() : null;
        })(),
        lastRunAt: fetchState?.lastRunAt ?? null,
        result: fetchState?.result ?? null,
      },
      publish: {
        enabled: settings.autoPublishEnabled,
        times: settings.autoPublishTimes,
        nextAt: nextPublish ? new Date(nextPublish).toISOString() : null,
        lastRunAt: publishState?.lastRunAt ?? null,
        result: publishState?.result ?? null,
      },
      epg: {
        enabled: settings.epgRefreshEnabled,
        times: settings.epgRefreshTimes,
        nextAt: nextEpg ? new Date(nextEpg).toISOString() : null,
        lastRunAt: epgState?.lastRunAt ?? null,
        result: epgState?.result ?? null,
      },
      snapshot: {
        enabled: settings.snapshotScheduleEnabled,
        times: settings.snapshotScheduleTimes,
        nextAt: (() => {
          const value = nextScheduledAt(parseCollectTimes(settings.snapshotScheduleTimes), Date.now());
          return value ? new Date(value).toISOString() : null;
        })(),
      },
    },
  });
});

adminRoutes.post('/tasks/cleanup-failed', async (c) => {
  const body = (await readJson<{ olderThanHours?: number }>(c)) ?? {};
  const hours = Math.max(0, Number(body.olderThanHours ?? 0) || 0);
  const removed = await deleteFailedTasks(c.env, hours * 3_600_000);
  await audit(c.env, c.get('actor'), 'tasks.cleanup_failed', 'bulk', { removed, hours });
  return ok({ removed });
});

adminRoutes.patch('/tasks/:id', async (c) => {
  const body = await readJson<{ action?: string }>(c);
  if (!body?.action) return fail('缺少 action');
  const message = await mutateTask(c.env, c.req.param('id'), body.action);
  await audit(c.env, c.get('actor'), `task.${body.action}`, c.req.param('id'));
  return ok({ message });
});

adminRoutes.post('/tasks/:id/progress', async (c) => {
  const body = await readJson<{ done?: number; total?: number; message?: string }>(c);
  if (!body || !Number.isFinite(body.done)) return fail('缺少进度');
  await progressTask(c.env, c.req.param('id'), Number(body.done), Number(body.total) || undefined, typeof body.message === 'string' ? body.message : undefined);
  return ok({ ok: true });
});

adminRoutes.get('/feedback', async (c) => {
  const status = c.req.query('status') ?? 'open';
  const q = c.req.query('q') ?? '';
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 100) || 100));
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0);
  const feedback = await listFeedback(c.env, status, limit, { q, offset });
  return ok({ items: feedback });
});

adminRoutes.post('/feedback/:id/probe', async (c) => {
  const feedback = await getFeedback(c.env, c.req.param('id'));
  if (!feedback) return fail('报障记录不存在', 404);
  if (!feedback.entry_key) return fail('该报障没有关联线路，无法转探测');
  const task = await createTask(c.env, {
    type: 'probe-lines',
    source: 'manual',
    priority: 90,
    payload: { line_keys: feedback.entry_key, phase: 'pending', force: 'true', budget: '1', source_id: '' },
  });
  const dispatched = await dispatchNext(c.env);
  await updateFeedback(c.env, feedback.id, 'resolved');
  await audit(c.env, c.get('actor'), 'feedback.probe', feedback.id, { task: task.id, lineKey: feedback.entry_key });
  return ok({ taskId: task.id, message: dispatched.message });
});

adminRoutes.get('/audit', async (c) => {
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0);
  const q = c.req.query('q') ?? '';
  const action = c.req.query('action') ?? '';
  const items = await listAudit(c.env, { limit, offset, q, action });
  return ok({ items });
});

function normalizeFailureText(text: string): string {
  return text
    .replace(/https?:\/\/[^\s"'<>]+/gi, '<地址>')
    .replace(/\b\d{2,}\b/g, '<数字>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function failureStage(text: string): string {
  if (/播放列表|解析|0 条|not_playlist/i.test(text)) return '解析';
  if (/EPG|节目单|xmltv/i.test(text)) return '节目单';
  if (/探测|probe|测活/i.test(text)) return '探测';
  if (/发布|publish/i.test(text)) return '发布';
  return '抓取';
}

adminRoutes.get('/insights/failures', async (c) => {
  const days = Math.min(30, Math.max(1, Number(c.req.query('days') ?? 7) || 7));
  const [sourceRows, runRows] = await Promise.all([
    c.env.DB.prepare("SELECT id, last_error FROM sources WHERE last_error IS NOT NULL AND last_error <> ''").all<{ id: string; last_error: string }>(),
    c.env.DB.prepare("SELECT error FROM runs WHERE error IS NOT NULL AND error <> '' AND started_at >= datetime('now', ?) ORDER BY started_at DESC LIMIT 500")
      .bind(`-${days} days`)
      .all<{ error: string }>(),
  ]);
  const buckets = new Map<string, { pattern: string; stage: string; count: number; sources: Set<string>; example: string }>();
  const push = (message: string, sourceId?: string) => {
    const pattern = normalizeFailureText(message);
    if (!pattern) return;
    const stage = failureStage(pattern);
    const key = `${stage}|${pattern}`;
    const bucket = buckets.get(key) ?? { pattern, stage, count: 0, sources: new Set<string>(), example: message.slice(0, 200) };
    bucket.count += 1;
    if (sourceId) bucket.sources.add(sourceId);
    buckets.set(key, bucket);
  };
  for (const row of runRows.results ?? []) push(row.error);
  for (const row of sourceRows.results ?? []) push(row.last_error, row.id);
  const categories = [...buckets.values()]
    .map((bucket) => ({ pattern: bucket.pattern, stage: bucket.stage, count: bucket.count, sources: [...bucket.sources], example: bucket.example }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
  const byStage = new Map<string, number>();
  for (const category of categories) byStage.set(category.stage, (byStage.get(category.stage) ?? 0) + category.count);
  return ok({
    days,
    total: categories.reduce((sum, item) => sum + item.count, 0),
    categories,
    byStage: [...byStage.entries()].map(([stage, count]) => ({ stage, count })),
  });
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
  const settings = await loadSettings(c.env);
  await applySourceStats(c.env, body.stats, { degrade: settings.sourceDegradeThreshold, pause: settings.sourcePauseThreshold });
  return ok({ synced: body.stats.length });
});

/** Runner -> D1: refresh only the source line counts after probing. */
adminRoutes.post('/sync/source-counts', async (c) => {
  const body = await readJson<{ counts?: Array<{ sourceId?: string; entryCount?: number; aliveCount?: number }> }>(c);
  if (!Array.isArray(body?.counts)) return fail('缺少 counts');
  const statements = body.counts
    .filter((item) => item && typeof item.sourceId === 'string' && Number.isFinite(item.entryCount) && Number.isFinite(item.aliveCount))
    .map((item) =>
      c.env.DB.prepare(
        "UPDATE sources SET entry_count = ?, alive_count = ?, updated_at = datetime('now') WHERE id = ?",
      ).bind(Math.max(0, Number(item.entryCount)), Math.max(0, Number(item.aliveCount)), item.sourceId),
    );
  if (statements.length) await c.env.DB.batch(statements);
  return ok({ synced: statements.length });
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
  error?: string;
  sourceName?: string;
  sourceSite?: string;
  sourceReputation?: number;
  sourceTier?: 'high' | 'normal' | 'low';
}

/**
 * On-demand liveness preview for the detection center. Runs at most 30 checks
 * in one request (Workers subrequest limits) and does not mutate state.
 */
adminRoutes.post('/lines/liveness', async (c) => {
  const body = await readJson<{ keys?: unknown }>(c);
  const keys = Array.isArray(body?.keys)
    ? [...new Set(body.keys.filter((key): key is string => typeof key === 'string').map((key) => key.trim()).filter(Boolean))].slice(0, 30)
    : [];
  if (!keys.length) return fail('keys 不能为空');
  const state = await loadLines(c.env);
  const byKey = new Map((state?.lines ?? []).map((line) => [line.key, line]));
  const selected = keys.map((key) => byKey.get(key)).filter((line): line is LineEntry => Boolean(line));
  if (!selected.length) return fail('线路不存在', 404);
  const results = await mapPool(selected, 8, async (line) => {
    const result = await probeLiveness(line.url, { headers: line.headers });
    return {
      key: line.key,
      ok: result.ok,
      status: result.status ?? null,
      latencyMs: result.latencyMs,
      error: result.error ?? null,
      inconclusive: Boolean(result.inconclusive),
    };
  });
  return ok({ results });
});

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
        error: line.error ?? undefined,
      })),
    );
  }

  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const status = c.req.query('status') ?? '';
  const sourceId = c.req.query('sourceId') ?? '';
  const resolution = c.req.query('resolution') ?? '';
  const minSpeed = Number(c.req.query('minSpeed') ?? '0') || 0;
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0);
  const limit = Math.min(Math.max(1, Number(c.req.query('limit') ?? 200) || 200), 5000);

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
  const items = rows.slice(offset, offset + limit).map((row) => ({
    ...row,
    sourceName: meta.get(row.sourceId)?.name ?? row.sourceId,
    sourceSite: meta.get(row.sourceId)?.site ?? '未知来源',
    sourceReputation: meta.get(row.sourceId)?.reputation,
    sourceTier: meta.get(row.sourceId)?.tier,
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
  // Serve raw bytes: sharded line state is gzip-compressed and must not be
  // decoded as UTF-8 by KV (that silently corrupts the binary and the runner
  // would read zero lines). Text artifacts keep working because the runner
  // decodes non-gzip bytes as UTF-8.
  // The last publish records every artifact size in state/publish-sizes.json,
  // so large files can be streamed without first buffering them in memory.
  const sizes = await getJson<{ items?: Array<{ key: string; bytes: number }> }>(c.env, 'state/publish-sizes.json');
  const known = sizes?.items?.find((item) => item.key === key);
  const baseHeaders = (contentType: string, length?: number): Record<string, string> => ({
    'content-type': contentType,
    'cache-control': 'no-store',
    ...(length ? { 'content-length': String(length) } : {}),
  });
  if (known && known.bytes > 2 * 1024 * 1024) {
    const stream = await c.env.KV.get(key, 'stream');
    if (!stream) return fail('产物不存在', 404);
    return new Response(stream, { headers: baseHeaders('application/octet-stream', known.bytes) });
  }
  const existing = await c.env.KV.getWithMetadata<{ contentType?: string }>(key, 'arrayBuffer');
  if (!existing.value) return fail('产物不存在', 404);
  return new Response(existing.value, {
    headers: baseHeaders(existing.metadata?.contentType ?? 'application/octet-stream', existing.value.byteLength),
  });
});

adminRoutes.put('/artifacts/*', async (c) => {
  const key = artifactKey(c.req.path);
  if (!key) return fail('缺少 key');
  const contentType = c.req.query('type') ?? c.req.header('content-type') ?? 'application/octet-stream';
  const body = await c.req.arrayBuffer();
  if (body.byteLength > 24 * 1024 * 1024) return fail('产物超过 KV 单值 24MB 限制', 413);
  try {
    const meta = await putArtifact(c.env, key, body, contentType);
    return ok({ key, size: meta.size, etag: meta.etag });
  } catch (error) {
    console.error('artifact put failed', key, body.byteLength, error);
    return fail(error instanceof Error ? error.message : String(error), 500);
  }
});

adminRoutes.delete('/artifacts/*', async (c) => {
  const key = artifactKey(c.req.path);
  if (!key) return fail('缺少 key');
  await c.env.KV.delete(key);
  return ok({ ok: true });
});
