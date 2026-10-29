import { Hono } from 'hono';
import { compareLines, qualityOf, qualityRank, type LineEntry, type Quality } from '@iptv/core';
import type { AppEnv, Env } from '../env.js';
import {
  audit,
  deleteLineOverrides,
  listChannels,
  listLineOverrides,
  listSources,
  loadSettings,
  upsertLineOverride,
} from '../db.js';
import { fail, ok, readJson } from '../lib/http.js';
import { getJson } from '../lib/store.js';
import { countryOfGroup } from '../lib/channelCountry.js';

export const poolRoutes = new Hono<AppEnv>();

const PREMIUM_PER_CHANNEL = 12;

type PoolName = 'premium' | 'backup' | 'pending' | 'quarantine' | 'rejected';

interface PoolLine extends LineEntry {
  pool: PoolName;
  autoPool: PoolName;
  overridden: boolean;
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
  for (const line of lines) {
    const item = counts.get(line.channelId) ?? { premium: 0, backup: 0, pending: 0, quarantine: 0, rejected: 0 };
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

  const filtered = lines.filter((line) => {
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
      reason: line.reason,
      status: line.status,
      score: line.score,
      passCount: line.passCount,
      lastProbeAt: line.lastProbeAt,
    })),
  });
});

const VALID_POOLS = new Set(['premium', 'backup', 'pending', 'quarantine', 'rejected']);

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
  const { lines } = await loadPool(c.env);
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
    const attrs = [
      line.tvgId ? `tvg-id="${escapeM3u(line.tvgId)}"` : '',
      `tvg-name="${escapeM3u(line.channelName)}"`,
      line.logo ? `tvg-logo="${escapeM3u(line.logo)}"` : '',
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
