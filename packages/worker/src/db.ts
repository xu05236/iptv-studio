import type { AppSettings, RunReport, SourceRunStats } from '@iptv/core';
import { DEFAULT_SETTINGS } from '@iptv/core';
import type { Env } from './env.js';
import { parseJsonField } from './lib/http.js';

export interface SourceRow {
  id: string;
  name: string;
  kind: string;
  url: string | null;
  origin: string;
  enabled: number;
  priority: number;
  weight: number;
  region: string | null;
  operator: string | null;
  tags: string;
  etag: string | null;
  last_modified: string | null;
  last_fetch_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  entry_count: number;
  alive_count: number;
  refresh_hours: number;
  reputation: number;
  tier: string;
  consecutive_failures: number;
  status: string;
  r2_key: string | null;
  notes: string | null;
  filters: string | null;
  content_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChannelRow {
  id: string;
  name: string;
  tvg_id: string | null;
  group_title: string | null;
  logo: string | null;
  number: number | null;
  enabled: number;
  sort: number;
  aliases: string;
  epg_source: string | null;
  updated_at: string;
}

export interface SubscriptionRow {
  id: string;
  name: string;
  token: string;
  enabled: number;
  groups: string;
  exclude_groups: string;
  channel_ids: string;
  line_keys: string;
  pool_mode: string;
  min_resolution: string;
  min_speed_kbps: number;
  protocols: string;
  max_lines_per_channel: number;
  show_region_suffix: number;
  include_epg: number;
  format: string;
  created_at: string;
  updated_at: string;
}

export interface RuleRow {
  id: string;
  name: string;
  enabled: number;
  priority: number;
  kind: string;
  spec: string;
  created_at: string;
  updated_at: string;
}

export interface RunRow {
  id: string;
  trigger: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  sources: number;
  channels: number;
  lines: number;
  alive: number;
  dead: number;
  probed: number;
  bytes: number;
  duration_ms: number;
  warnings: string;
  error: string | null;
  log_key: string | null;
  actor: string | null;
  created_at: string;
}

export interface FeedbackRow {
  id: string;
  entry_key: string | null;
  channel_id: string | null;
  source_id: string | null;
  kind: string;
  message: string | null;
  reporter_hash: string | null;
  status: string;
  created_at: string;
}

// ---------------------------------------------------------------- sources

export async function listSources(env: Env): Promise<SourceRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM sources ORDER BY priority ASC, created_at ASC').all<SourceRow>();
  return results;
}

export async function getSource(env: Env, id: string): Promise<SourceRow | null> {
  return env.DB.prepare('SELECT * FROM sources WHERE id = ?').bind(id).first<SourceRow>();
}

export interface NewSource {
  id: string;
  name: string;
  kind: string;
  url?: string | null;
  origin: string;
  enabled?: number;
  priority?: number;
  region?: string | null;
  operator?: string | null;
  tags?: string;
  r2Key?: string | null;
  notes?: string | null;
  filters?: unknown;
  contentHash?: string | null;
  refreshHours?: number;
}

export async function insertSource(env: Env, input: NewSource): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sources (id, name, kind, url, origin, enabled, priority, region, operator, tags, r2_key, notes, filters, content_hash, refresh_hours, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
  )
    .bind(
      input.id,
      input.name,
      input.kind,
      input.url ?? null,
      input.origin,
      input.enabled ?? 1,
      input.priority ?? 100,
      input.region ?? null,
      input.operator ?? null,
      input.tags ?? '[]',
      input.r2Key ?? null,
      input.notes ?? null,
      input.filters ? JSON.stringify(input.filters) : null,
      input.contentHash ?? null,
      input.refreshHours ?? 24,
    )
    .run();
}

const SOURCE_COLUMNS: Record<string, string> = {
  name: 'name',
  kind: 'kind',
  url: 'url',
  enabled: 'enabled',
  priority: 'priority',
  weight: 'weight',
  region: 'region',
  operator: 'operator',
  tags: 'tags',
  notes: 'notes',
  status: 'status',
  reputation: 'reputation',
  tier: 'tier',
  r2_key: 'r2_key',
  last_fetch_at: 'last_fetch_at',
  last_ok_at: 'last_ok_at',
  last_error: 'last_error',
  entry_count: 'entry_count',
  alive_count: 'alive_count',
  filters: 'filters',
  content_hash: 'content_hash',
  refresh_hours: 'refresh_hours',
};

export async function updateSource(env: Env, id: string, patch: Record<string, unknown>): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const column = SOURCE_COLUMNS[key];
    if (!column) continue;
    sets.push(`${column} = ?`);
    values.push(key === 'enabled' ? (value ? 1 : 0) : key === 'tags' && Array.isArray(value) ? JSON.stringify(value) : key === 'filters' ? JSON.stringify(value) : value);
  }
  if (!sets.length) return false;
  sets.push("updated_at = datetime('now')");
  values.push(id);
  await env.DB.prepare(`UPDATE sources SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
  return true;
}

export async function deleteSource(env: Env, id: string): Promise<void> {
  await env.DB.prepare('DELETE FROM sources WHERE id = ?').bind(id).run();
}

// ---------------------------------------------------------------- channels

export async function listChannels(env: Env): Promise<ChannelRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM channels ORDER BY sort ASC, name ASC').all<ChannelRow>();
  return results;
}

export async function getChannel(env: Env, id: string): Promise<ChannelRow | null> {
  return env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first<ChannelRow>();
}

export async function upsertChannelSeeds(
  env: Env,
  seeds: Array<{ id: string; name: string; group: string; tvgId?: string; logo?: string; aliases?: string[] }>,
): Promise<number> {
  if (!seeds.length) return 0;

  // Compare against existing rows first. D1 counts every UPSERT as a written
  // row, and syncing ~5000 unchanged channels on every run dominated the free
  // daily write quota.
  const existing = new Map<string, { group_title: string | null; tvg_id: string | null; logo: string | null }>();
  const ids = seeds.map((seed) => seed.id);
  for (let offset = 0; offset < ids.length; offset += 80) {
    const chunk = ids.slice(offset, offset + 80);
    const { results } = await env.DB.prepare(
      `SELECT id, group_title, tvg_id, logo FROM channels WHERE id IN (${chunk.map(() => '?').join(', ')})`,
    ).bind(...chunk).all<{ id: string; group_title: string | null; tvg_id: string | null; logo: string | null }>();
    for (const row of results) existing.set(row.id, row);
  }

  const statements: D1PreparedStatement[] = [];
  let changed = 0;
  for (const seed of seeds) {
    const row = existing.get(seed.id);
    const needsUpdate = !row
      || (!row.tvg_id && seed.tvgId)
      || (!row.logo && seed.logo)
      || ((!row.group_title || row.group_title === '其他') && seed.group && seed.group !== '其他');
    if (!needsUpdate) continue;
    changed++;
    statements.push(
      env.DB.prepare(
        `INSERT INTO channels (id, name, tvg_id, group_title, logo, aliases)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           tvg_id = COALESCE(channels.tvg_id, excluded.tvg_id),
           logo = COALESCE(channels.logo, excluded.logo),
           group_title = CASE
             WHEN (channels.group_title IS NULL OR channels.group_title = '' OR channels.group_title = '其他')
               AND excluded.group_title IS NOT NULL AND excluded.group_title <> '其他'
             THEN excluded.group_title
             ELSE channels.group_title
           END,
           updated_at = datetime('now')`,
      ).bind(seed.id, seed.name, seed.tvgId ?? null, seed.group, seed.logo ?? null, JSON.stringify(seed.aliases ?? [])),
    );
    for (const alias of [seed.name, seed.tvgId, ...(seed.aliases ?? [])].filter(Boolean) as string[]) {
      statements.push(env.DB.prepare('INSERT OR IGNORE INTO aliases (alias, channel_id) VALUES (?, ?)').bind(alias, seed.id));
    }
  }

  await runBatched(env, statements);
  return changed;
}

/** D1 batches have a hard statement cap; keep chunks small and predictable. */
async function runBatched(env: Env, statements: D1PreparedStatement[], size = 40): Promise<void> {
  for (let offset = 0; offset < statements.length; offset += size) {
    await env.DB.batch(statements.slice(offset, offset + size));
  }
}

const CHANNEL_COLUMNS: Record<string, string> = {
  name: 'name',
  tvg_id: 'tvg_id',
  group_title: 'group_title',
  logo: 'logo',
  number: 'number',
  enabled: 'enabled',
  sort: 'sort',
  epg_source: 'epg_source',
};

export async function updateChannel(env: Env, id: string, patch: Record<string, unknown>): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const column = CHANNEL_COLUMNS[key];
    if (!column) continue;
    sets.push(`${column} = ?`);
    values.push(key === 'enabled' ? (value ? 1 : 0) : value);
  }
  if (!sets.length) return false;
  sets.push("updated_at = datetime('now')");
  values.push(id);
  await env.DB.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
  return true;
}

export async function deleteChannel(env: Env, id: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM channels WHERE id = ?').bind(id),
    env.DB.prepare('DELETE FROM aliases WHERE channel_id = ?').bind(id),
  ]);
}

export async function addAlias(env: Env, channelId: string, alias: string): Promise<void> {
  await env.DB.prepare('INSERT OR IGNORE INTO aliases (alias, channel_id) VALUES (?, ?)').bind(alias, channelId).run();
}

export async function removeAlias(env: Env, channelId: string, alias: string): Promise<void> {
  await env.DB.prepare('DELETE FROM aliases WHERE alias = ? AND channel_id = ?').bind(alias, channelId).run();
}

export async function loadAliasMap(env: Env): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare('SELECT alias, channel_id FROM aliases').all<{ alias: string; channel_id: string }>();
  const map: Record<string, string> = {};
  for (const row of results) map[row.alias] = row.channel_id;
  return map;
}

export async function channelAliases(env: Env, channelId: string): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT alias FROM aliases WHERE channel_id = ?').bind(channelId).all<{ alias: string }>();
  return results.map((row) => row.alias);
}

export interface LineOverrideRow {
  line_key: string;
  pool: string;
  channel_id: string | null;
  reason: string | null;
  updated_at: string;
}

export async function listLineOverrides(env: Env): Promise<LineOverrideRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM line_overrides').all<LineOverrideRow>();
  return results;
}

export interface LineTombstoneRow {
  url: string;
  line_key: string | null;
  channel_id: string | null;
  reason: string | null;
  created_at: string;
}

export async function listLineTombstones(env: Env): Promise<LineTombstoneRow[]> {
  const { results } = await env.DB.prepare('SELECT url, line_key, channel_id, reason, created_at FROM line_tombstones ORDER BY created_at DESC').all<LineTombstoneRow>();
  return results;
}

export async function addLineTombstones(
  env: Env,
  rows: Array<{ url: string; lineKey?: string | null; channelId?: string | null; reason?: string | null }>,
): Promise<number> {
  const statements = rows.map((row) =>
    env.DB.prepare(
      `INSERT INTO line_tombstones (url, line_key, channel_id, reason, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(url) DO UPDATE SET reason = excluded.reason, created_at = datetime('now')`,
    ).bind(row.url, row.lineKey ?? null, row.channelId ?? null, row.reason ?? null),
  );
  for (let offset = 0; offset < statements.length; offset += 40) {
    await env.DB.batch(statements.slice(offset, offset + 40));
  }
  return statements.length;
}

export async function removeLineTombstones(env: Env, urls: string[]): Promise<number> {
  if (!urls.length) return 0;
  const statements = urls.map((url) => env.DB.prepare('DELETE FROM line_tombstones WHERE url = ?').bind(url));
  for (let offset = 0; offset < statements.length; offset += 40) {
    await env.DB.batch(statements.slice(offset, offset + 40));
  }
  return urls.length;
}

export async function upsertLineOverride(
  env: Env,
  lineKey: string,
  pool: string,
  channelId?: string | null,
  reason?: string | null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO line_overrides (line_key, pool, channel_id, reason, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(line_key) DO UPDATE SET
       pool = excluded.pool, channel_id = excluded.channel_id,
       reason = excluded.reason, updated_at = datetime('now')`,
  ).bind(lineKey, pool, channelId ?? null, reason ?? null).run();
}

export async function deleteLineOverrides(env: Env, keys: string[]): Promise<number> {
  let removed = 0;
  for (const key of keys) {
    const result = await env.DB.prepare('DELETE FROM line_overrides WHERE line_key = ?').bind(key).run();
    removed += result.meta.changes ?? 0;
  }
  return removed;
}

export async function mergeChannels(env: Env, fromIds: string[], intoId: string): Promise<number> {
  const target = await getChannel(env, intoId);
  if (!target) throw new Error('目标频道不存在');
  let merged = 0;
  const fromSet = new Set(fromIds);
  for (const id of fromIds) {
    if (id === intoId) continue;
    const source = await getChannel(env, id);
    if (!source) continue;
    await addAlias(env, intoId, source.name);
    if (source.tvg_id) await addAlias(env, intoId, source.tvg_id);
    await env.DB.prepare('UPDATE aliases SET channel_id = ? WHERE channel_id = ?').bind(intoId, id).run();
    await env.DB.prepare('DELETE FROM channels WHERE id = ?').bind(id).run();
    merged++;
  }

  // Existing probe state still points at the old x- channel. Remap it now so
  // the next export/subscription does not resurrect the deleted channel.
  const linesState = await env.KV.get<{ lines: Array<{ channelId: string }> }>('state/lines.json', 'json');
  if (linesState?.lines) {
    let changed = 0;
    for (const line of linesState.lines) {
      if (fromSet.has(line.channelId)) {
        line.channelId = intoId;
        changed++;
      }
    }
    if (changed) await env.KV.put('state/lines.json', JSON.stringify(linesState));
  }
  const probeState = await env.KV.get<{ items: Array<{ channelId?: string }> }>('state/probe.json', 'json');
  if (probeState?.items) {
    let changed = 0;
    for (const item of probeState.items) {
      if (item.channelId && fromSet.has(item.channelId)) {
        item.channelId = intoId;
        changed++;
      }
    }
    if (changed) await env.KV.put('state/probe.json', JSON.stringify(probeState));
  }
  return merged;
}

// ---------------------------------------------------------------- subscriptions

export async function listSubscriptions(env: Env): Promise<SubscriptionRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM subscriptions ORDER BY created_at ASC').all<SubscriptionRow>();
  return results;
}

export async function getSubscription(env: Env, id: string): Promise<SubscriptionRow | null> {
  return env.DB.prepare('SELECT * FROM subscriptions WHERE id = ?').bind(id).first<SubscriptionRow>();
}

export async function getSubscriptionByToken(env: Env, token: string): Promise<SubscriptionRow | null> {
  return env.DB.prepare('SELECT * FROM subscriptions WHERE token = ?').bind(token).first<SubscriptionRow>();
}

export async function createSubscription(env: Env, row: SubscriptionRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO subscriptions (id, name, token, enabled, groups, exclude_groups, channel_ids, line_keys, pool_mode, min_resolution, min_speed_kbps, protocols, max_lines_per_channel, show_region_suffix, include_epg, format)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.id,
      row.name,
      row.token,
      row.enabled,
      row.groups,
      row.exclude_groups,
      row.channel_ids,
      row.line_keys,
      row.pool_mode,
      row.min_resolution,
      row.min_speed_kbps,
      row.protocols,
      row.max_lines_per_channel,
      row.show_region_suffix,
      row.include_epg,
      row.format,
    )
    .run();
}

const SUB_COLUMNS: Record<string, string> = {
  name: 'name',
  enabled: 'enabled',
  groups: 'groups',
  exclude_groups: 'exclude_groups',
  excludeGroups: 'exclude_groups',
  channel_ids: 'channel_ids',
  channelIds: 'channel_ids',
  line_keys: 'line_keys',
  lineKeys: 'line_keys',
  pool_mode: 'pool_mode',
  poolMode: 'pool_mode',
  min_resolution: 'min_resolution',
  minResolution: 'min_resolution',
  min_speed_kbps: 'min_speed_kbps',
  minSpeedKbps: 'min_speed_kbps',
  protocols: 'protocols',
  max_lines_per_channel: 'max_lines_per_channel',
  maxLinesPerChannel: 'max_lines_per_channel',
  show_region_suffix: 'show_region_suffix',
  showRegionSuffix: 'show_region_suffix',
  include_epg: 'include_epg',
  includeEpg: 'include_epg',
  format: 'format',
  token: 'token',
};

export async function updateSubscription(env: Env, id: string, patch: Record<string, unknown>): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const column = SUB_COLUMNS[key];
    if (!column) continue;
    sets.push(`${column} = ?`);
    values.push(Array.isArray(value) ? JSON.stringify(value) : typeof value === 'boolean' ? (value ? 1 : 0) : value);
  }
  if (!sets.length) return false;
  sets.push("updated_at = datetime('now')");
  values.push(id);
  await env.DB.prepare(`UPDATE subscriptions SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
  return true;
}

export async function deleteSubscription(env: Env, id: string): Promise<void> {
  await env.DB.prepare('DELETE FROM subscriptions WHERE id = ?').bind(id).run();
}

// ---------------------------------------------------------------- rules

export async function listRules(env: Env): Promise<RuleRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM rules ORDER BY priority ASC, created_at ASC').all<RuleRow>();
  return results;
}

export async function upsertRule(env: Env, row: RuleRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO rules (id, name, enabled, priority, kind, spec) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, enabled = excluded.enabled, priority = excluded.priority,
       kind = excluded.kind, spec = excluded.spec, updated_at = datetime('now')`,
  )
    .bind(row.id, row.name, row.enabled, row.priority, row.kind, row.spec)
    .run();
}

export async function deleteRule(env: Env, id: string): Promise<void> {
  await env.DB.prepare('DELETE FROM rules WHERE id = ?').bind(id).run();
}

// ---------------------------------------------------------------- runs

export async function listRuns(env: Env, limit = 20): Promise<RunRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').bind(limit).all<RunRow>();
  return results;
}

export async function getRun(env: Env, id: string): Promise<RunRow | null> {
  return env.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(id).first<RunRow>();
}

export async function upsertRun(env: Env, report: RunReport): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO runs (id, trigger, status, started_at, finished_at, sources, channels, lines, alive, dead, probed, bytes, duration_ms, warnings, error, log_key, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status, finished_at = excluded.finished_at, sources = excluded.sources,
       channels = excluded.channels, lines = excluded.lines, alive = excluded.alive, dead = excluded.dead,
       probed = excluded.probed, bytes = excluded.bytes, duration_ms = excluded.duration_ms,
       warnings = excluded.warnings, error = excluded.error, log_key = COALESCE(excluded.log_key, runs.log_key)`,
  )
    .bind(
      report.id,
      report.trigger,
      report.status,
      report.startedAt,
      report.finishedAt ?? null,
      report.sources,
      report.channels,
      report.lines,
      report.alive,
      report.dead,
      report.probed,
      report.bytes,
      report.durationMs,
      JSON.stringify(report.warnings ?? []),
      report.error ?? null,
      report.logKey ?? null,
      report.actor ?? null,
    )
    .run();
}

// ---------------------------------------------------------------- feedback

export async function insertFeedback(env: Env, row: FeedbackRow): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO feedback (id, entry_key, channel_id, source_id, kind, message, reporter_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(row.id, row.entry_key, row.channel_id, row.source_id, row.kind, row.message, row.reporter_hash)
    .run();
}

export async function listFeedback(env: Env, status: string | null, limit = 50): Promise<FeedbackRow[]> {
  const query = status && status !== 'all'
    ? env.DB.prepare('SELECT * FROM feedback WHERE status = ? ORDER BY created_at DESC LIMIT ?').bind(status, limit)
    : env.DB.prepare('SELECT * FROM feedback ORDER BY created_at DESC LIMIT ?').bind(limit);
  const { results } = await query.all<FeedbackRow>();
  return results;
}

export async function updateFeedback(env: Env, id: string, status: string): Promise<void> {
  await env.DB.prepare('UPDATE feedback SET status = ? WHERE id = ?').bind(status, id).run();
}

// ---------------------------------------------------------------- settings

export async function loadSettings(env: Env): Promise<AppSettings> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'app'").first<{ value: string }>();
  const stored = parseJsonField<Record<string, unknown>>(row?.value, {});
  // Only keep keys that still exist in AppSettings, so retired knobs do not
  // leak back into the admin UI or the runner.
  const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (key in stored) settings[key] = stored[key];
  }
  return settings as unknown as AppSettings;
}

export async function saveSettings(env: Env, patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await loadSettings(env);
  const next = { ...current, ...patch };
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('app', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  )
    .bind(JSON.stringify(next))
    .run();
  return next;
}

// ---------------------------------------------------------------- stats / audit

export async function applySourceStats(
  env: Env,
  stats: Array<SourceRunStats & { reputation?: number; tier?: string }>,
): Promise<void> {
  if (!stats.length) return;
  const day = new Date().toISOString().slice(0, 10);
  const existingRows = await listSources(env);
  const existing = new Map(existingRows.map((row) => [row.id, row]));
  const statements: D1PreparedStatement[] = [];

  for (const stat of stats) {
    const before = existing.get(stat.sourceId);
    if (!before) continue;
    const failures = stat.fetched && !stat.error ? 0 : before.consecutive_failures + 1;
    // Permanently broken sources should not linger in the list. Delete them
    // after five consecutive failures; orphan line cleanup removes leftovers.
    if (failures >= 5) {
      statements.push(env.DB.prepare('DELETE FROM sources WHERE id = ?').bind(stat.sourceId));
      statements.push(env.DB.prepare('DELETE FROM source_stats WHERE source_id = ?').bind(stat.sourceId));
      continue;
    }
    const status = failures >= 3 ? 'degraded' : 'active';
    statements.push(
      env.DB.prepare(
        `UPDATE sources SET entry_count = ?, alive_count = ?, last_fetch_at = ?,
           last_ok_at = CASE WHEN ? = 1 THEN datetime('now') ELSE last_ok_at END,
           last_error = ?, etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified),
           reputation = COALESCE(?, reputation), tier = COALESCE(?, tier),
           consecutive_failures = ?, status = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).bind(
        stat.parsed,
        stat.alive,
        new Date().toISOString(),
        stat.fetched && !stat.error ? 1 : 0,
        stat.error ?? null,
        stat.etag ?? null,
        stat.lastModified ?? null,
        stat.reputation ?? null,
        stat.tier ?? null,
        failures,
        status,
        stat.sourceId,
      ),
    );
    statements.push(
      env.DB.prepare(
        `INSERT INTO source_stats (source_id, day, fetched, parsed, alive, dead, avg_speed, avg_latency, reputation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id, day) DO UPDATE SET
           fetched = excluded.fetched, parsed = excluded.parsed, alive = excluded.alive, dead = excluded.dead,
           avg_speed = excluded.avg_speed, avg_latency = excluded.avg_latency, reputation = excluded.reputation`,
      ).bind(
        stat.sourceId,
        day,
        stat.fetched ? 1 : 0,
        stat.parsed,
        stat.alive,
        stat.dead,
        Math.round(stat.avgSpeedKbps),
        Math.round(stat.avgLatencyMs),
        stat.reputation ?? 0,
      ),
    );
  }

  if (statements.length) await runBatched(env, statements);
}

export async function audit(env: Env, actor: string, action: string, target: string, detail?: unknown): Promise<void> {
  await env.DB.prepare('INSERT INTO audit (actor, action, target, detail) VALUES (?, ?, ?, ?)')
    .bind(actor, action, target, detail === undefined ? null : JSON.stringify(detail))
    .run();
}

export async function countOpenFeedback(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS total FROM feedback WHERE status = 'open'").first<{ total: number }>();
  return row?.total ?? 0;
}

export async function purgeOldRows(env: Env, days = 90): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM runs WHERE started_at < datetime('now', ?)").bind(`-${days} days`),
    env.DB.prepare("DELETE FROM feedback WHERE created_at < datetime('now', ?)").bind(`-${days} days`),
    env.DB.prepare("DELETE FROM source_stats WHERE day < date('now', ?)").bind(`-${days} days`),
  ]);
}
