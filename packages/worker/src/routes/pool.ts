import { Hono } from 'hono';
import { channelLogo, compareLines, qualityOf, qualityRank, type LineEntry, type Quality } from '@iptv/core';
import type { AppEnv, Env } from '../env.js';
import {
  audit,
  createSubscription,
  deleteLineOverrides,
  listChannels,
  listLineOverrides,
  listSources,
  listSubscriptions,
  loadSettings,
  upsertLineOverride,
  type SubscriptionRow,
} from '../db.js';
import { fail, ok, parseJsonField, randomId, randomToken, readJson } from '../lib/http.js';
import { getJson } from '../lib/store.js';
import { countryOfGroup } from '../lib/channelCountry.js';
import { loadIndex } from '../lib/catalog.js';

export const poolRoutes = new Hono<AppEnv>();

const PREMIUM_PER_CHANNEL = 12;

type PoolName = 'premium' | 'backup' | 'candidate' | 'pending' | 'quarantine' | 'rejected';

/** An alive line only counts as a premium/backup candidate once its quality is known. */
function qualityConfirmed(line: LineEntry): boolean {
  if (line.height && line.height > 0) return true;
  return Boolean(line.resolution && !/unknown/i.test(line.resolution));
}

interface PoolLine extends LineEntry {
  pool: PoolName;
  autoPool: PoolName;
  overridden: boolean;
  promoted?: boolean;
  reason?: string;
  transport: 'direct' | 'relay';
  channelName: string;
  group: string;
  country: string;
  sourceName: string;
  tvgId?: string;
  logo?: string;
}

async function loadPool(env: Env) {
  const [state, channels, sources, settings, overrides] = await Promise.all([
    getJson<{ lines: LineEntry[] }>(env, 'state/lines.json'),
    listChannels(env),
    listSources(env),
    loadSettings(env),
    listLineOverrides(env),
  ]);
  const channelMap = new Map(channels.map((channel) => [channel.id, channel]));
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const overrideMap = new Map(overrides.map((row) => [row.line_key, row]));
  const byChannel = new Map<string, LineEntry[]>();
  const seenUrls = new Set<string>();
  for (const line of state?.lines ?? []) {
    // A URL can be reported by multiple sources; dedupe the pool view and
    // premium ranking by URL rather than counting it several times.
    if (seenUrls.has(line.url)) continue;
    seenUrls.add(line.url);
    const list = byChannel.get(line.channelId) ?? [];
    list.push(line);
    byChannel.set(line.channelId, list);
  }

  const lines: PoolLine[] = [];
  for (const [channelId, list] of byChannel) {
    const channel = channelMap.get(channelId);
    const group = channel?.group_title ?? '其他';
    const country = countryOfGroup(group);
    const sorted = [...list].sort(compareLines);
    let premium = 0;
    for (const line of sorted) {
      let autoPool: PoolName;
      if (!line.lastProbeAt) autoPool = 'pending';
      else if (line.status === 'dead') autoPool = 'rejected';
      else if (line.status === 'suspect') autoPool = 'quarantine';
      else if (line.status === 'alive' && !qualityConfirmed(line)) autoPool = 'candidate';
      else if (premium < Math.max(1, Math.min(PREMIUM_PER_CHANNEL, settings.maxLinesPerChannel * 2))) {
        autoPool = 'premium';
        premium++;
      } else autoPool = 'backup';
      const override = overrideMap.get(line.key);
      const pool = (override?.pool as PoolName | undefined) ?? autoPool;
      lines.push({
        ...line,
        autoPool,
        pool,
        overridden: Boolean(override),
        reason: override?.reason ?? undefined,
        transport: line.url.startsWith('https:') ? 'direct' : 'relay',
        channelName: channel?.name ?? channelId,
        group,
        country,
        sourceName: sourceMap.get(line.sourceId)?.name ?? line.sourceId,
        tvgId: channel?.tvg_id ?? undefined,
        logo: channel?.logo ?? undefined,
      });
    }
  }

  const counts = new Map<string, Record<PoolName, number>>();
  const premiumTarget = Math.max(1, Math.min(PREMIUM_PER_CHANNEL, settings.maxLinesPerChannel * 2));
  const byChannelLines = new Map<string, PoolLine[]>();
  for (const line of lines) {
    const list = byChannelLines.get(line.channelId) ?? [];
    list.push(line);
    byChannelLines.set(line.channelId, list);
  }
  for (const channelLines of byChannelLines.values()) {
    let premium = channelLines.filter((line) => line.pool === 'premium').length;
    if (premium >= premiumTarget) continue;
    const candidates = channelLines
      .filter((line) => line.pool === 'backup' && !line.overridden)
      .sort(compareLines);
    for (const line of candidates) {
      if (premium >= premiumTarget) break;
      line.pool = 'premium';
      line.promoted = true;
      premium++;
    }
  }
  for (const line of lines) {
    const item = counts.get(line.channelId) ?? { premium: 0, backup: 0, candidate: 0, pending: 0, quarantine: 0, rejected: 0 };
    item[line.pool]++;
    counts.set(line.channelId, item);
  }

  const countries = new Map<string, Map<string, Array<{ id: string; name: string; counts: Record<PoolName, number> }>>>();
  for (const [channelId, channelCounts] of counts) {
    const channel = channelMap.get(channelId);
    const group = channel?.group_title ?? '其他';
    const country = countryOfGroup(group);
    const groups = countries.get(country) ?? new Map();
    const channelsInGroup = groups.get(group) ?? [];
    channelsInGroup.push({ id: channelId, name: channel?.name ?? channelId, counts: channelCounts });
    groups.set(group, channelsInGroup);
    countries.set(country, groups);
  }

  return {
    lines,
    tree: [...countries.entries()].map(([country, groups]) => {
      const groupList = [...groups.entries()].map(([group, channelList]) => ({
        group,
        total: channelList.reduce((sum, channel) => sum + Object.values(channel.counts).reduce((a, b) => a + b, 0), 0),
        channels: channelList.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
      }));
      return {
        country,
        total: groupList.reduce((sum, group) => sum + group.total, 0),
        groups: groupList,
      };
    }),
  };
}

poolRoutes.get('/tree', async (c) => {
  const { tree } = await loadPool(c.env);
  return ok({ countries: tree });
});

poolRoutes.get('/lines', async (c) => {
  const { lines } = await loadPool(c.env);
  const country = c.req.query('country') ?? '';
  const group = c.req.query('group') ?? '';
  const channelId = c.req.query('channelId') ?? '';
  const pool = (c.req.query('pool') ?? '') as PoolName | '';
  const transport = c.req.query('transport') ?? '';
  const resolution = c.req.query('resolution') ?? '';
  const minSpeed = Math.max(0, Number(c.req.query('minSpeed') ?? 0) || 0);
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const page = Math.max(1, Number(c.req.query('page') ?? 1) || 1);
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));
  const minRank = resolution ? qualityRank(resolution as Quality) : -1;
  const subscriptionId = (c.req.query('subscriptionId') ?? '').trim();

  // "View the lines this subscription would actually use" needs the same
  // channel/group/key scope as the playlist renderer, not just a text search.
  let subscriptionLineKeys: Set<string> | null = null;
  let subscriptionChannels: string[] = [];
  let subscriptionGroups: string[] = [];
  let subscriptionExclude: string[] = [];
  if (subscriptionId) {
    const subscription = (await listSubscriptions(c.env)).find((item) => item.id === subscriptionId);
    if (!subscription) return fail('订阅不存在', 404);
    const keys = parseJsonField<string[]>(subscription.line_keys, []);
    subscriptionLineKeys = keys.length ? new Set(keys) : null;
    subscriptionChannels = parseJsonField<string[]>(subscription.channel_ids, []);
    subscriptionGroups = parseJsonField<string[]>(subscription.groups, []);
    subscriptionExclude = parseJsonField<string[]>(subscription.exclude_groups, []);
  }

  const filtered = lines.filter((line) => {
    if (subscriptionLineKeys && !subscriptionLineKeys.has(line.key)) return false;
    if (!subscriptionLineKeys && subscriptionChannels.length && !subscriptionChannels.includes(line.channelId)) return false;
    if (!subscriptionLineKeys && subscriptionGroups.length && !subscriptionGroups.includes(line.group)) return false;
    if (!subscriptionLineKeys && subscriptionExclude.includes(line.group)) return false;
    if (country && line.country !== country) return false;
    if (group && line.group !== group) return false;
    if (channelId && line.channelId !== channelId) return false;
    if (pool && line.pool !== pool) return false;
    if (transport && line.transport !== transport) return false;
    if (minSpeed && (line.speedKbps ?? 0) < minSpeed) return false;
    if (minRank >= 0 && qualityRank(qualityOf(line)) < minRank) return false;
    if (q) {
      const haystack = `${line.channelName} ${line.name} ${line.sourceName} ${line.url}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  filtered.sort(
    (a, b) =>
      a.country.localeCompare(b.country, 'zh-CN') ||
      a.group.localeCompare(b.group, 'zh-CN') ||
      a.channelName.localeCompare(b.channelName, 'zh-CN') ||
      compareLines(a, b),
  );
  const start = (page - 1) * limit;
  return ok({
    total: filtered.length,
    page,
    limit,
    items: filtered.slice(start, start + limit).map((line) => ({
      key: line.key,
      channelId: line.channelId,
      channelName: line.channelName,
      group: line.group,
      country: line.country,
      sourceId: line.sourceId,
      sourceName: line.sourceName,
      name: line.name,
      url: line.url,
      resolution: line.resolution,
      height: line.height,
      speedKbps: line.speedKbps,
      protocol: line.protocol,
      transport: line.transport,
      pool: line.pool,
      autoPool: line.autoPool,
      overridden: line.overridden,
      promoted: line.promoted,
      reason: line.reason,
      status: line.status,
      score: line.score,
      passCount: line.passCount,
      lastProbeAt: line.lastProbeAt,
    })),
  });
});

const VALID_POOLS = new Set(['premium', 'backup', 'candidate', 'pending', 'quarantine', 'rejected']);

poolRoutes.post('/override', async (c) => {
  const body = (await readJson<{ keys?: unknown; pool?: unknown; reason?: unknown }>(c)) ?? {};
  const keys = Array.isArray(body.keys) ? body.keys.filter((key): key is string => typeof key === 'string').slice(0, 200) : [];
  const pool = typeof body.pool === 'string' ? body.pool : '';
  if (!keys.length) return fail('keys 不能为空');
  if (!VALID_POOLS.has(pool)) return fail('pool 不合法');
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 200) : null;
  for (const key of keys) await upsertLineOverride(c.env, key, pool, null, reason);
  await audit(c.env, c.get('actor'), 'pool.override', 'bulk', { keys, pool, reason });
  return ok({ updated: keys.length });
});

poolRoutes.post('/reset', async (c) => {
  const body = (await readJson<{ keys?: unknown }>(c)) ?? {};
  const keys = Array.isArray(body.keys) ? body.keys.filter((key): key is string => typeof key === 'string').slice(0, 200) : [];
  if (!keys.length) return fail('keys 不能为空');
  const removed = await deleteLineOverrides(c.env, keys);
  await audit(c.env, c.get('actor'), 'pool.reset', 'bulk', { keys, removed });
  return ok({ removed });
});

function escapeM3u(value: string): string {
  return value.replace(/"/g, '&quot;').replace(/[\r\n]+/g, ' ');
}

poolRoutes.post('/export', async (c) => {
  const body = (await readJson<Record<string, unknown>>(c)) ?? {};
  const [{ lines }, index] = await Promise.all([loadPool(c.env), loadIndex(c.env)]);
  // The D1 channel rows rarely carry a logo; the published index is where the
  // seed/source logos live, so use it as the fallback for tvg-logo.
  const meta = new Map((index?.channels ?? []).map((channel) => [channel.id, channel]));
  const keys = Array.isArray(body.keys)
    ? body.keys.filter((key): key is string => typeof key === 'string').slice(0, 500)
    : [];
  const country = String(body.country ?? '');
  const group = String(body.group ?? '');
  const channelId = String(body.channelId ?? '');
  const pool = String(body.pool ?? '');
  const transport = String(body.transport ?? '');
  const resolution = String(body.resolution ?? '');
  const minSpeed = Math.max(0, Number(body.minSpeed ?? 0) || 0);
  const q = String(body.q ?? '').trim().toLowerCase();
  const minRank = resolution ? qualityRank(resolution as Quality) : -1;
  const keySet = new Set(keys);

  const selected = lines.filter((line) => {
    if (keySet.size && !keySet.has(line.key)) return false;
    if (country && line.country !== country) return false;
    if (group && line.group !== group) return false;
    if (channelId && line.channelId !== channelId) return false;
    if (pool && line.pool !== pool) return false;
    if (transport && line.transport !== transport) return false;
    if (minSpeed && (line.speedKbps ?? 0) < minSpeed) return false;
    if (minRank >= 0 && qualityRank(qualityOf(line)) < minRank) return false;
    if (q && !`${line.channelName} ${line.name} ${line.sourceName} ${line.url}`.toLowerCase().includes(q)) return false;
    return true;
  });
  if (!selected.length) return fail('筛选结果为空，无法导出', 422);
  selected.sort((a, b) => a.channelName.localeCompare(b.channelName, 'zh-CN') || compareLines(a, b));

  const out = ['#EXTM3U'];
  for (const line of selected) {
    const channel = meta.get(line.channelId);
    const tvgId = line.tvgId ?? channel?.tvgId;
    // Index rows do not carry the seed logo, so synthesise it from tvg-id the
    // same way the subscription playlists do (jsDelivr fanmingming pack).
    const logo = channelLogo({ logo: line.logo ?? channel?.logo, tvgId, name: line.channelName });
    const attrs = [
      tvgId ? `tvg-id="${escapeM3u(tvgId)}"` : '',
      `tvg-name="${escapeM3u(line.channelName)}"`,
      logo ? `tvg-logo="${escapeM3u(logo)}"` : '',
      `group-title="${escapeM3u(line.group)}"`,
    ].filter(Boolean);
    out.push(`#EXTINF:-1 ${attrs.join(' ')},${line.channelName} · ${line.sourceName}`);
    if (line.headers?.userAgent) out.push(`#EXTVLCOPT:http-user-agent=${line.headers.userAgent}`);
    if (line.headers?.referer) out.push(`#EXTVLCOPT:http-referrer=${line.headers.referer}`);
    out.push(line.url);
  }
  return new Response(out.join('\n'), {
    headers: {
      'content-type': 'audio/x-mpegurl; charset=utf-8',
      'content-disposition': `attachment; filename="line-pool-${new Date().toISOString().slice(0, 10)}.m3u"`,
      'cache-control': 'no-store',
    },
  });
});

poolRoutes.post('/subscription', async (c) => {
  const body = (await readJson<Record<string, unknown>>(c)) ?? {};
  const { lines } = await loadPool(c.env);
  const keys = Array.isArray(body.keys)
    ? body.keys.filter((key): key is string => typeof key === 'string').slice(0, 500)
    : [];
  const keySet = new Set(keys);
  const country = String(body.country ?? '');
  const group = String(body.group ?? '');
  const channelId = String(body.channelId ?? '');
  const pool = String(body.pool ?? '');
  const transport = String(body.transport ?? '');
  const resolution = String(body.resolution ?? '');
  const minSpeed = Math.max(0, Number(body.minSpeed ?? 0) || 0);
  const q = String(body.q ?? '').trim().toLowerCase();
  const minRank = resolution ? qualityRank(resolution as Quality) : -1;

  const selected = lines.filter((line) => {
    if (keySet.size && !keySet.has(line.key)) return false;
    if (country && line.country !== country) return false;
    if (group && line.group !== group) return false;
    if (channelId && line.channelId !== channelId) return false;
    if (pool && line.pool !== pool) return false;
    if (transport && line.transport !== transport) return false;
    if (minSpeed && (line.speedKbps ?? 0) < minSpeed) return false;
    if (minRank >= 0 && qualityRank(qualityOf(line)) < minRank) return false;
    if (q && !`${line.channelName} ${line.name} ${line.sourceName} ${line.url}`.toLowerCase().includes(q)) return false;
    return true;
  });
  if (!selected.length) return fail('筛选结果为空，无法保存订阅', 422);
  if (selected.length > 500) return fail('自定义订阅最多 500 条线路', 422);

  const now = new Date().toISOString();
  const row: SubscriptionRow = {
    id: `sub-${randomId(8)}`,
    name: String(body.name ?? `线路池订阅 ${now.slice(0, 10)}`).slice(0, 60),
    token: randomToken(),
    enabled: 1,
    groups: '[]',
    exclude_groups: '[]',
    channel_ids: '[]',
    line_keys: JSON.stringify(selected.map((line) => line.key)),
    pool_mode: 'custom',
    min_resolution: 'any',
    min_speed_kbps: 0,
    protocols: '[]',
    max_lines_per_channel: 999,
    show_region_suffix: 1,
    include_epg: 1,
    format: 'm3u',
    created_at: now,
    updated_at: now,
  };
  await createSubscription(c.env, row);
  await audit(c.env, c.get('actor'), 'pool.subscription', row.id, { lines: selected.length });
  return ok({ id: row.id, token: row.token, lines: selected.length });
});
