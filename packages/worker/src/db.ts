import type { AppSettings, RunReport, SourceRunStats } from '@iptv/core';
import { computeParseDrop, DEFAULT_SETTINGS } from '@iptv/core';
import type { Env } from './env.js';
import { parseJsonField } from './lib/http.js';
import { loadLines, saveLines } from './lib/linesState.js';

export interface SourceRow {
  id: string;
  name: string;
  kind: string;
  url: string | null;
  mirror_urls: string | null;
  fetch_timeout_ms: number | null;
  fetch_concurrency: number | null;
  fetch_delay_ms: number | null;
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
  last_error_kind: string | null;
  entry_count: number;
  alive_count: number;
  refresh_hours: number | null;
  reputation: number;
  tier: string;
  consecutive_failures: number;
  status: string;
  r2_key: string | null;
  notes: string | null;
  filters: string | null;
  request_headers: string | null;
  fetch_mode: string | null;
  allow_insecure_tls: number;
  merge_channel_name: string | null;
  merge_channel_group: string | null;
  parse_report: string | null;
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
  pool_ids: string;
  pool_mode: string;
  filter_mode: string;
  merged_mode: string;
  merged_max_lines: number;
  include_cn_reachable: number;
  proxy_mode: string;
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

export interface SubscriptionTokenRow {
  token: string;
  subscription_id: string;
  label: string;
  enabled: number;
  last_seen_at: string | null;
  created_at: string;
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
  task_id: string | null;
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
  message: string | null;
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
  requestHeaders?: unknown;
  mirrorUrls?: string[] | null;
  fetchMode?: string | null;
  allowInsecureTls?: boolean | number | null;
  mergeChannelName?: string | null;
  mergeChannelGroup?: string | null;
  fetchTimeoutMs?: number | null;
  fetchConcurrency?: number | null;
  fetchDelayMs?: number | null;
  contentHash?: string | null;
  refreshHours?: number | null;
}

export async function insertSource(env: Env, input: NewSource): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sources (id, name, kind, url, mirror_urls, origin, enabled, priority, region, operator, tags, r2_key, notes, filters, request_headers, fetch_mode, fetch_timeout_ms, fetch_concurrency, fetch_delay_ms, allow_insecure_tls, merge_channel_name, merge_channel_group, content_hash, refresh_hours, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
  )
    .bind(
      input.id,
      input.name,
      input.kind,
      input.url ?? null,
      input.mirrorUrls?.length ? JSON.stringify(input.mirrorUrls) : null,
      input.origin,
      input.enabled ?? 1,
      input.priority ?? 100,
      input.region ?? null,
      input.operator ?? null,
      input.tags ?? '[]',
      input.r2Key ?? null,
      input.notes ?? null,
      input.filters ? JSON.stringify(input.filters) : null,
      input.requestHeaders && Object.keys(input.requestHeaders as Record<string, unknown>).length ? JSON.stringify(input.requestHeaders) : null,
      input.fetchMode ?? 'direct',
      input.fetchTimeoutMs ?? null,
      input.fetchConcurrency ?? null,
      input.fetchDelayMs ?? null,
      input.allowInsecureTls ? 1 : 0,
      input.mergeChannelName ?? null,
      input.mergeChannelGroup ?? null,
      input.contentHash ?? null,
      input.refreshHours ?? -1,
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
  consecutive_failures: 'consecutive_failures',
  reputation: 'reputation',
  tier: 'tier',
  r2_key: 'r2_key',
  last_fetch_at: 'last_fetch_at',
  last_ok_at: 'last_ok_at',
  last_error: 'last_error',
  last_error_kind: 'last_error_kind',
  entry_count: 'entry_count',
  alive_count: 'alive_count',
  filters: 'filters',
  request_headers: 'request_headers',
  mirror_urls: 'mirror_urls',
  fetch_mode: 'fetch_mode',
  fetch_timeout_ms: 'fetch_timeout_ms',
  fetch_concurrency: 'fetch_concurrency',
  fetch_delay_ms: 'fetch_delay_ms',
  allow_insecure_tls: 'allow_insecure_tls',
  mergeChannelName: 'merge_channel_name',
  mergeChannelGroup: 'merge_channel_group',
  merge_channel_name: 'merge_channel_name',
  merge_channel_group: 'merge_channel_group',
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
  const { results } = await env.DB.prepare('SELECT * FROM channels ORDER BY CASE WHEN sort IS NULL THEN 1 ELSE 0 END, sort ASC, name ASC').all<ChannelRow>();
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

let favoritesReady: Promise<void> | null = null;

function ensureLineFavorites(env: Env): Promise<void> {
  if (!favoritesReady) {
    favoritesReady = env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS line_favorites (line_key TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')))',
    )
      .run()
      .then(() => undefined)
      .catch((error) => {
        favoritesReady = null;
        throw error;
      });
  }
  return favoritesReady;
}

export async function listLineFavorites(env: Env): Promise<string[]> {
  await ensureLineFavorites(env);
  const { results } = await env.DB.prepare('SELECT line_key FROM line_favorites').all<{ line_key: string }>();
  return results.map((row) => row.line_key);
}

export async function setLineFavorite(env: Env, keys: string[], favorite: boolean): Promise<number> {
  await ensureLineFavorites(env);
  if (!keys.length) return 0;
  if (favorite) {
    await env.DB.batch(keys.map((key) => env.DB.prepare('INSERT OR IGNORE INTO line_favorites (line_key) VALUES (?)').bind(key)));
  } else {
    await env.DB.batch(keys.map((key) => env.DB.prepare('DELETE FROM line_favorites WHERE line_key = ?').bind(key)));
  }
  return keys.length;
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
  const fromSet = new Set(fromIds);

  // Read state before mutating so each merge record knows which line keys move.
  const linesState = await loadLines(env);
  const probeState = await env.KV.get<{ items: Array<{ channelId?: string; key?: string; lineKey?: string }> }>('state/probe.json', 'json');
  // Capture per-source keys before the remap below collapses them into intoId.
  const keysBySource = new Map<string, string[]>();
  for (const id of fromIds) {
    if (id === intoId) continue;
    keysBySource.set(
      id,
      (linesState?.lines ?? []).filter((line) => line.channelId === id && line.key).map((line) => line.key as string),
    );
  }

  // Persist the line/probe remap first. If this write fails, no channel has
  // been deleted yet, so the merge can be retried without losing lines.
  if (linesState?.lines) {
    let changed = 0;
    for (const line of linesState.lines) {
      if (fromSet.has(line.channelId)) {
        line.channelId = intoId;
        changed++;
      }
    }
    if (changed) await saveLines(env, linesState.lines, linesState.generatedAt ?? new Date().toISOString());
  }
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

  let merged = 0;
  for (const id of fromIds) {
    if (id === intoId) continue;
    const source = await getChannel(env, id);
    if (!source) continue;
    const aliases = (await env.DB.prepare('SELECT alias FROM aliases WHERE channel_id = ?').bind(id).all<{ alias: string }>()).results.map((row) => row.alias);
    await addAlias(env, intoId, source.name);
    if (source.tvg_id) await addAlias(env, intoId, source.tvg_id);
    await env.DB.prepare('UPDATE aliases SET channel_id = ? WHERE channel_id = ?').bind(intoId, id).run();
    await env.DB.prepare('DELETE FROM channels WHERE id = ?').bind(id).run();
    await env.DB.prepare('INSERT INTO channel_merges (id, from_id, to_id, snapshot, line_keys) VALUES (?, ?, ?, ?, ?)')
      .bind(`merge-${crypto.randomUUID()}`, id, intoId, JSON.stringify({ channel: source, aliases }), JSON.stringify(keysBySource.get(id) ?? []))
      .run();
    merged++;
  }
  return merged;
}

export interface ChannelMergeRow {
  id: string;
  from_id: string;
  to_id: string;
  snapshot: string;
  line_keys: string;
  created_at: string;
}

export async function listChannelMerges(env: Env, limit = 10): Promise<Array<{ id: string; fromId: string; toId: string; fromName: string | null; toName: string | null; lineCount: number; createdAt: string }>> {
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.from_id, m.to_id, m.line_keys, m.created_at, f.name AS from_name, t.name AS to_name
     FROM channel_merges m
     LEFT JOIN channels f ON f.id = m.from_id
     LEFT JOIN channels t ON t.id = m.to_id
     ORDER BY m.created_at DESC LIMIT ?`,
  ).bind(limit).all<{ id: string; from_id: string; to_id: string; line_keys: string; created_at: string; from_name: string | null; to_name: string | null }>();
  return results.map((row) => ({
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    fromName: row.from_name,
    toName: row.to_name,
    lineCount: ((JSON.parse(row.line_keys) as string[]) || []).length,
    createdAt: row.created_at,
  }));
}

export async function undoChannelMerge(env: Env, mergeId: string): Promise<{ restoredLines: number } | null> {
  const row = await env.DB.prepare('SELECT * FROM channel_merges WHERE id = ?').bind(mergeId).first<ChannelMergeRow>();
  if (!row) return null;
  const snapshot = JSON.parse(row.snapshot) as { channel: ChannelRow; aliases: string[] };
  const channel = snapshot.channel;
  const keys = new Set(JSON.parse(row.line_keys) as string[]);
  await env.DB.prepare(
    `INSERT INTO channels (id, name, tvg_id, group_title, logo, number, enabled, sort, aliases, epg_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, tvg_id = excluded.tvg_id, group_title = excluded.group_title,
       logo = excluded.logo, number = excluded.number, enabled = excluded.enabled,
       sort = excluded.sort, aliases = excluded.aliases, epg_source = excluded.epg_source`,
  ).bind(
    channel.id, channel.name, channel.tvg_id ?? null, channel.group_title ?? null, channel.logo ?? null,
    channel.number ?? null, channel.enabled ?? 1, channel.sort ?? 0, channel.aliases ?? '[]', channel.epg_source ?? null,
  ).run();
  for (const alias of snapshot.aliases ?? []) {
    await env.DB.prepare('INSERT OR IGNORE INTO aliases (alias, channel_id) VALUES (?, ?)').bind(alias, channel.id).run();
  }

  let restoredLines = 0;
  const linesState = await loadLines(env);
  if (linesState?.lines) {
    for (const line of linesState.lines) {
      if (line.channelId === row.to_id && line.key && keys.has(line.key)) {
        line.channelId = channel.id;
        restoredLines++;
      }
    }
    if (restoredLines) await saveLines(env, linesState.lines, linesState.generatedAt ?? new Date().toISOString());
  }
  const probeState = await env.KV.get<{ items: Array<{ channelId?: string; key?: string; lineKey?: string }> }>('state/probe.json', 'json');
  if (probeState?.items) {
    let changed = 0;
    for (const item of probeState.items) {
      if (item.channelId !== row.to_id) continue;
      const key = item.lineKey ?? item.key;
      if (key && keys.has(key)) {
        item.channelId = channel.id;
        changed++;
      }
    }
    if (changed) await env.KV.put('state/probe.json', JSON.stringify(probeState));
  }
  await env.DB.prepare('DELETE FROM channel_merges WHERE id = ?').bind(mergeId).run();
  return { restoredLines };
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
    `INSERT INTO subscriptions (id, name, token, enabled, groups, exclude_groups, channel_ids, line_keys, pool_ids, pool_mode, filter_mode, proxy_mode, min_resolution, min_speed_kbps, protocols, max_lines_per_channel, show_region_suffix, include_epg, format, merged_mode, merged_max_lines, include_cn_reachable)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      row.pool_ids,
      row.pool_mode,
      row.filter_mode,
      row.proxy_mode,
      row.min_resolution,
      row.min_speed_kbps,
      row.protocols,
      row.max_lines_per_channel,
      row.show_region_suffix,
      row.include_epg,
      row.format,
      row.merged_mode,
      row.merged_max_lines,
      row.include_cn_reachable,
    )
    .run();
  await env.DB.prepare('INSERT OR IGNORE INTO subscription_tokens (token, subscription_id, label, enabled) VALUES (?, ?, ?, 1)')
    .bind(row.token, row.id, '主令牌')
    .run();
}

export async function listSubscriptionTokens(env: Env, subscriptionId: string): Promise<SubscriptionTokenRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM subscription_tokens WHERE subscription_id = ? ORDER BY created_at ASC')
    .bind(subscriptionId)
    .all<SubscriptionTokenRow>();
  return results;
}

export interface RelayUsageRow {
  token: string;
  label: string | null;
  day: string;
  requests: number;
  bytes: number;
}

/** Per-token relay traffic for one subscription (last N UTC days). */
export async function listRelayUsage(env: Env, subscriptionId: string, days = 7): Promise<RelayUsageRow[]> {
  const span = Math.max(0, Math.min(29, days - 1));
  const { results } = await env.DB.prepare(
    `SELECT u.token, t.label, u.day, u.requests, u.bytes
     FROM relay_usage u JOIN subscription_tokens t ON t.token = u.token
     WHERE t.subscription_id = ? AND u.day >= date('now', ?)
     ORDER BY u.day DESC, u.requests DESC`,
  )
    .bind(subscriptionId, `-${span} days`)
    .all<RelayUsageRow>();
  return results;
}

export async function createSubscriptionToken(env: Env, subscriptionId: string, label: string): Promise<SubscriptionTokenRow> {
  const token = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  await env.DB.prepare('INSERT INTO subscription_tokens (token, subscription_id, label, enabled) VALUES (?, ?, ?, 1)')
    .bind(token, subscriptionId, label.slice(0, 40))
    .run();
  const row = await env.DB.prepare('SELECT * FROM subscription_tokens WHERE token = ?').bind(token).first<SubscriptionTokenRow>();
  return row!;
}

export async function setSubscriptionTokenEnabled(env: Env, subscriptionId: string, token: string, enabled: boolean): Promise<boolean> {
  const result = await env.DB.prepare('UPDATE subscription_tokens SET enabled = ? WHERE subscription_id = ? AND token = ?')
    .bind(enabled ? 1 : 0, subscriptionId, token)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteSubscriptionToken(env: Env, subscriptionId: string, token: string): Promise<boolean> {
  const result = await env.DB.prepare('DELETE FROM subscription_tokens WHERE subscription_id = ? AND token = ?')
    .bind(subscriptionId, token)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** 每个设备令牌每小时最多写一次 last_seen（单条条件 UPDATE，不先读）。 */
export async function touchSubscriptionToken(env: Env, token: string, now = Date.now()): Promise<void> {
  const stamp = new Date(now).toISOString();
  const cutoff = new Date(now - 3_600_000).toISOString();
  await env.DB.prepare('UPDATE subscription_tokens SET last_seen_at = ? WHERE token = ? AND (last_seen_at IS NULL OR last_seen_at < ?)')
    .bind(stamp, token, cutoff)
    .run();
}

/**
 * Resolve a subscription from either a device token or the legacy primary
 * token. Device tokens win so disabling one actually revokes it even though
 * the primary token still sits in the subscriptions row.
 */
export async function resolveSubscriptionByToken(
  env: Env,
  token: string,
): Promise<{ row: SubscriptionRow; tokenRow: SubscriptionTokenRow | null } | null> {
  const tokenRow = await env.DB.prepare('SELECT * FROM subscription_tokens WHERE token = ?').bind(token).first<SubscriptionTokenRow>();
  if (tokenRow) {
    if (tokenRow.enabled !== 1) return null;
    const row = await getSubscription(env, tokenRow.subscription_id);
    if (!row || row.enabled !== 1) return null;
    return { row, tokenRow };
  }
  const legacy = await getSubscriptionByToken(env, token);
  return legacy ? { row: legacy, tokenRow: null } : null;
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
  pool_ids: 'pool_ids',
  poolIds: 'pool_ids',
  pool_mode: 'pool_mode',
  filter_mode: 'filter_mode',
  filterMode: 'filter_mode',
  merged_mode: 'merged_mode',
  mergedMode: 'merged_mode',
  include_cn_reachable: 'include_cn_reachable',
  includeCnReachable: 'include_cn_reachable',
  merged_max_lines: 'merged_max_lines',
  mergedMaxLines: 'merged_max_lines',
  poolMode: 'pool_mode',
  proxy_mode: 'proxy_mode',
  proxyMode: 'proxy_mode',
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

// ---------------------------------------------------------------- custom pools

export interface CustomPoolRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface CustomPoolListItem extends CustomPoolRow {
  count: number;
}

export async function listCustomPools(env: Env): Promise<CustomPoolListItem[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.name, p.created_at, p.updated_at, COUNT(l.line_key) AS count
     FROM custom_pools p LEFT JOIN custom_pool_lines l ON l.pool_id = p.id
     GROUP BY p.id ORDER BY p.created_at ASC`,
  ).all<CustomPoolListItem>();
  return results;
}

export async function createCustomPool(env: Env, id: string, name: string): Promise<CustomPoolRow | null> {
  const existing = await env.DB.prepare('SELECT id FROM custom_pools WHERE name = ?').bind(name).first<{ id: string }>();
  if (existing) return null;
  try {
    await env.DB.prepare('INSERT INTO custom_pools (id, name) VALUES (?, ?)').bind(id, name).run();
  } catch (error) {
    // Two requests can pass the SELECT above at the same time and race on the
    // UNIQUE(name) constraint; treat that as "name already taken" instead of 500.
    if (error instanceof Error && /unique/i.test(error.message)) return null;
    throw error;
  }
  return env.DB.prepare('SELECT * FROM custom_pools WHERE id = ?').bind(id).first<CustomPoolRow>();
}

export async function renameCustomPool(env: Env, id: string, name: string): Promise<boolean> {
  const clash = await env.DB.prepare('SELECT id FROM custom_pools WHERE name = ? AND id <> ?').bind(name, id).first<{ id: string }>();
  if (clash) return false;
  const result = await env.DB.prepare("UPDATE custom_pools SET name = ?, updated_at = datetime('now') WHERE id = ?").bind(name, id).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteCustomPool(env: Env, id: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT id FROM custom_pools WHERE id = ?').bind(id).first<{ id: string }>();
  if (!row) return false;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM custom_pool_lines WHERE pool_id = ?').bind(id),
    env.DB.prepare('DELETE FROM custom_pools WHERE id = ?').bind(id),
  ]);
  return true;
}

export async function addCustomPoolLines(env: Env, poolId: string, keys: string[]): Promise<number> {
  const unique = [...new Set(keys)];
  if (!unique.length) return 0;
  let added = 0;
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const results = await env.DB.batch(chunk.map((key) => env.DB.prepare('INSERT OR IGNORE INTO custom_pool_lines (pool_id, line_key) VALUES (?, ?)').bind(poolId, key)));
    // INSERT OR IGNORE reports 0 changes for duplicate keys; callers show the
    // real number added instead of the number submitted.
    for (const result of results) added += result.meta.changes ?? 0;
  }
  return added;
}

export async function removeCustomPoolLines(env: Env, poolId: string, keys: string[]): Promise<number> {
  const unique = [...new Set(keys)];
  if (!unique.length) return 0;
  let removed = 0;
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const placeholders = chunk.map(() => '?').join(',');
    const result = await env.DB.prepare(`DELETE FROM custom_pool_lines WHERE pool_id = ? AND line_key IN (${placeholders})`).bind(poolId, ...chunk).run();
    removed += result.meta.changes ?? 0;
  }
  return removed;
}

export async function listCustomPoolLineKeys(env: Env, poolId: string): Promise<string[]> {
  const { results } = await env.DB.prepare('SELECT line_key FROM custom_pool_lines WHERE pool_id = ?').bind(poolId).all<{ line_key: string }>();
  return results.map((row) => row.line_key);
}

export async function listCustomPoolMembers(env: Env, poolIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (!poolIds.length) return out;
  const placeholders = poolIds.map(() => '?').join(',');
  const { results } = await env.DB.prepare(`SELECT pool_id, line_key FROM custom_pool_lines WHERE pool_id IN (${placeholders})`)
    .bind(...poolIds)
    .all<{ pool_id: string; line_key: string }>();
  for (const row of results) {
    const set = out.get(row.pool_id) ?? new Set<string>();
    set.add(row.line_key);
    out.set(row.pool_id, set);
  }
  return out;
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

let runTaskColumnReady: Promise<void> | null = null;

function ensureRunTaskColumn(env: Env): Promise<void> {
  if (!runTaskColumnReady) {
    runTaskColumnReady = env.DB.prepare('ALTER TABLE runs ADD COLUMN task_id TEXT')
      .run()
      .then(() => undefined)
      .catch(() => undefined);
  }
  return runTaskColumnReady;
}

export async function listRuns(env: Env, limit = 20): Promise<RunRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').bind(limit).all<RunRow>();
  return results;
}

export async function getRun(env: Env, id: string): Promise<RunRow | null> {
  return env.DB.prepare('SELECT * FROM runs WHERE id = ?').bind(id).first<RunRow>();
}

/**
 * Placeholder run row created the moment a task is dispatched, so the run
 * history and the task board never disagree about whether something started.
 * The runner later replaces it with the real report (same task id).
 */
export async function upsertPlaceholderRun(
  env: Env,
  input: { taskId: string; trigger: string; status: 'running' | 'failed'; error?: string | null },
): Promise<void> {
  if (!env.DB) return;
  await ensureRunTaskColumn(env);
  const now = new Date().toISOString();
  const finished = input.status === 'running' ? null : now;
  await env.DB.prepare(
    `INSERT INTO runs (id, task_id, trigger, status, started_at, finished_at, sources, channels, lines, alive, dead, probed, bytes, duration_ms, warnings, message, error, log_key, actor)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, '[]', '已派发，等待 runner 上报', ?, NULL, 'system')
     ON CONFLICT(id) DO UPDATE SET
       task_id = excluded.task_id, trigger = excluded.trigger, status = excluded.status,
       finished_at = excluded.finished_at, message = excluded.message, error = excluded.error`,
  )
    .bind(`task:${input.taskId}`, input.taskId, input.trigger, input.status, now, finished, input.error ?? null)
    .run();
}

/** Mirror a task transition into its placeholder run (no-op if a real run replaced it). */
export async function finishPlaceholderRun(env: Env, taskId: string, status: string, error?: string | null): Promise<void> {
  if (!env.DB) return;
  await env.DB.prepare(
    `UPDATE runs SET status = ?, finished_at = ?, error = COALESCE(?, error) WHERE id = ?`,
  )
    .bind(status, new Date().toISOString(), error ?? null, `task:${taskId}`)
    .run()
    .catch(() => undefined);
}

export async function deletePlaceholderRun(env: Env, taskId: string): Promise<void> {
  if (!env.DB) return;
  await env.DB.prepare('DELETE FROM runs WHERE id = ?')
    .bind(`task:${taskId}`)
    .run()
    .catch(() => undefined);
}

export async function upsertRun(env: Env, report: RunReport): Promise<void> {
  await ensureRunTaskColumn(env);
  if (report.taskId) await deletePlaceholderRun(env, report.taskId);
  await env.DB.prepare(
    `INSERT INTO runs (id, task_id, trigger, status, started_at, finished_at, sources, channels, lines, alive, dead, probed, bytes, duration_ms, warnings, message, error, log_key, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       task_id = COALESCE(excluded.task_id, runs.task_id),
       status = excluded.status, finished_at = excluded.finished_at, sources = excluded.sources,
       channels = excluded.channels, lines = excluded.lines, alive = excluded.alive, dead = excluded.dead,
       probed = excluded.probed, bytes = excluded.bytes, duration_ms = excluded.duration_ms,
       warnings = excluded.warnings, message = COALESCE(excluded.message, runs.message), error = excluded.error, log_key = COALESCE(excluded.log_key, runs.log_key)`,
  )
    .bind(
      report.id,
      report.taskId ?? null,
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
      report.message ?? null,
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

export async function listFeedback(
  env: Env,
  status: string | null,
  limit = 50,
  options: { offset?: number; q?: string } = {},
): Promise<FeedbackRow[]> {
  const offset = Math.max(0, Number(options.offset) || 0);
  const q = (options.q ?? '').trim();
  const clauses: string[] = [];
  const binds: Array<string | number> = [];
  if (status && status !== 'all') {
    clauses.push('status = ?');
    binds.push(status);
  }
  if (q) {
    clauses.push('(message LIKE ? OR channel_id LIKE ? OR source_id LIKE ? OR entry_key LIKE ?)');
    const like = `%${q}%`;
    binds.push(like, like, like, like);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const { results } = await env.DB.prepare(`SELECT * FROM feedback${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset)
    .all<FeedbackRow>();
  return results;
}

export async function getFeedback(env: Env, id: string): Promise<FeedbackRow | null> {
  return env.DB.prepare('SELECT * FROM feedback WHERE id = ?').bind(id).first<FeedbackRow>();
}

export interface AuditRow {
  id: number;
  at: string;
  actor: string | null;
  action: string;
  target: string | null;
  detail: string | null;
}

export async function listAudit(
  env: Env,
  options: { limit?: number; offset?: number; q?: string; action?: string } = {},
): Promise<AuditRow[]> {
  const limit = Math.min(200, Math.max(1, Number(options.limit) || 50));
  const offset = Math.max(0, Number(options.offset) || 0);
  const clauses: string[] = [];
  const binds: Array<string | number> = [];
  if (options.action) {
    clauses.push('action = ?');
    binds.push(options.action);
  }
  if (options.q) {
    clauses.push('(action LIKE ? OR actor LIKE ? OR target LIKE ? OR detail LIKE ?)');
    const like = `%${options.q}%`;
    binds.push(like, like, like, like);
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const { results } = await env.DB.prepare(`SELECT * FROM audit${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset)
    .all<AuditRow>();
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
  thresholds?: { degrade?: number; pause?: number },
): Promise<void> {
  if (!stats.length) return;
  const degrade = Math.max(1, Number(thresholds?.degrade) || 3);
  const pause = Math.max(degrade + 1, Number(thresholds?.pause) || 5);
  const day = new Date().toISOString().slice(0, 10);
  const existingRows = await listSources(env);
  const existing = new Map(existingRows.map((row) => [row.id, row]));
  const statements: D1PreparedStatement[] = [];

  for (const stat of stats) {
    const before = existing.get(stat.sourceId);
    if (!before) continue;
    const empty = stat.fetched && !stat.error && stat.parsed === 0;
    const failures = stat.fetched && !stat.error && stat.parsed > 0 ? 0 : before.consecutive_failures + 1;
    // Sources that keep failing must not linger as "active" and burn a fetch
    // slot every run. Keep the row instead of deleting it: the admin UI needs
    // it to show why the source stopped and to let the user resume it.
    if (failures >= pause) {
      statements.push(
        env.DB.prepare(
          `UPDATE sources SET status = 'paused', consecutive_failures = ?, updated_at = datetime('now') WHERE id = ?`,
        ).bind(failures, stat.sourceId),
      );
      continue;
    }
    const status = failures >= degrade || empty ? 'degraded' : 'active';
    statements.push(
      env.DB.prepare(
        `UPDATE sources SET entry_count = ?, alive_count = ?, last_fetch_at = ?,
           last_ok_at = CASE WHEN ? = 1 THEN datetime('now') ELSE last_ok_at END,
           last_error = ?, last_error_kind = ?, etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified),
           reputation = COALESCE(?, reputation), tier = COALESCE(?, tier),
           parse_report = COALESCE(?, parse_report),
           consecutive_failures = ?, status = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).bind(
        stat.parsed,
        stat.alive,
        new Date().toISOString(),
        stat.fetched && !stat.error && stat.parsed > 0 ? 1 : 0,
        empty ? '解析出 0 条' : stat.error ?? null,
        stat.errorKind ?? null,
        stat.etag ?? null,
        stat.lastModified ?? null,
        stat.reputation ?? null,
        stat.tier ?? null,
        stat.parseReport ? JSON.stringify({ ...stat.parseReport, dropPercent: computeParseDrop(before.entry_count, stat.parseReport.entries) }) : null,
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
