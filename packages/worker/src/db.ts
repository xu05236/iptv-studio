import type { AppSettings, RunReport, SourceRunStats } from '@iptv/core';
import { computeParseDrop, DEFAULT_SETTINGS } from '@iptv/core';
import type { Env } from './env.js';
import { parseJsonField } from './lib/http.js';

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
  pool_mode: string;
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
  fetchTimeoutMs?: number | null;
  fetchConcurrency?: number | null;
  fetchDelayMs?: number | null;
  contentHash?: string | null;
  refreshHours?: number | null;
}

export async function insertSource(env: Env, input: NewSource): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sources (id, name, kind, url, mirror_urls, origin, enabled, priority, region, operator, tags, r2_key, notes, filters, request_headers, fetch_mode, fetch_timeout_ms, fetch_concurrency, fetch_delay_ms, content_hash, refresh_hours, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
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
    `INSERT INTO subscriptions (id, name, token, enabled, groups, exclude_groups, channel_ids, line_keys, pool_mode, proxy_mode, min_resolution, min_speed_kbps, protocols, max_lines_per_channel, show_region_suffix, include_epg, format)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      row.proxy_mode,
      row.min_resolution,
      row.min_speed_kbps,
      row.protocols,
      row.max_lines_per_channel,
      row.show_region_suffix,
      row.include_epg,
      row.format,
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
  pool_mode: 'pool_mode',
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

export async function upsertRun(env: Env, report: RunReport): Promise<void> {
  await ensureRunTaskColumn(env);
  await env.DB.prepare(
    `INSERT INTO runs (id, task_id, trigger, status, started_at, finished_at, sources, channels, lines, alive, dead, probed, bytes, duration_ms, warnings, error, log_key, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       task_id = COALESCE(excluded.task_id, runs.task_id),
       status = excluded.status, finished_at = excluded.finished_at, sources = excluded.sources,
       channels = excluded.channels, lines = excluded.lines, alive = excluded.alive, dead = excluded.dead,
       probed = excluded.probed, bytes = excluded.bytes, duration_ms = excluded.duration_ms,
       warnings = excluded.warnings, error = excluded.error, log_key = COALESCE(excluded.log_key, runs.log_key)`,
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
