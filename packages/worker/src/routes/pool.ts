import { Hono } from 'hono';
import { canonicalPoolUrl, channelLogo, compareLines, dedupePoolLines, qualityOf, qualityRank, type LineEntry, type PoolSnapshot, type Quality } from '@iptv/core';
import type { AppEnv, Env } from '../env.js';
import {
  addCustomPoolLines,
  addLineTombstones,
  audit,
  createCustomPool,
  createSubscription,
  deleteCustomPool,
  deleteLineOverrides,
  listChannels,
  listCustomPoolLineKeys,
  listCustomPools,
  listLineFavorites,
  listLineOverrides,
  listLineTombstones,
  listSources,
  listSubscriptions,
  loadSettings,
  removeCustomPoolLines,
  removeLineTombstones,
  renameCustomPool,
  setLineFavorite,
  upsertLineOverride,
  type SubscriptionRow,
} from '../db.js';
import { fail, ok, parseJsonField, randomId, randomToken, readJson } from '../lib/http.js';
import { getJson, putArtifact } from '../lib/store.js';
import { loadLines, saveLines } from '../lib/linesState.js';
import { createTask, dispatchNext } from '../lib/tasks.js';
import { countryOfGroup } from '../lib/channelCountry.js';
import { loadIndex } from '../lib/catalog.js';

export const poolRoutes = new Hono<AppEnv>();

/**
 * Remove lines from both the persisted state and the compact pool snapshot so
 * the next request already reflects the deletion (no publish required).
 * Tombstones are handled by the caller.
 */
async function removeLinesFromArtifacts(env: Env, keys: Set<string>): Promise<number> {
  let removed = 0;
  const state = await loadLines(env);
  if (state?.lines?.length) {
    const kept = state.lines.filter((line) => !keys.has(line.key));
    removed = state.lines.length - kept.length;
    if (removed) {
      await saveLines(env, kept, state.generatedAt ?? new Date().toISOString(), { allowEmpty: true });
    }
  }

  const snapshot = await getJson<PoolSnapshot>(env, 'state/pool.json');
  if (snapshot) {
    let changed = false;
    for (const [channelId, entry] of Object.entries(snapshot.channels)) {
      for (const bucket of ['premium', 'backup', 'candidate'] as const) {
        const before = entry[bucket].length;
        entry[bucket] = entry[bucket].filter((line) => !keys.has(line.key));
        if (entry[bucket].length !== before) changed = true;
      }
      if (!entry.premium.length && !entry.backup.length && !entry.candidate.length) {
        delete snapshot.channels[channelId];
        changed = true;
      }
    }
    if (changed) {
      await putArtifact(env, 'state/pool.json', JSON.stringify(snapshot), 'application/json; charset=utf-8');
    }
  }
  return removed;
}

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
  favorite: boolean;
  transport: 'direct' | 'relay';
  channelName: string;
  group: string;
  country: string;
  sourceName: string;
  sourceReputation: number;
  sourceTier: 'high' | 'normal' | 'low';
  tvgId?: string;
  logo?: string;
}

async function loadPool(env: Env) {
  const [state, channels, sources, settings, overrides, favorites] = await Promise.all([
    loadLines(env),
    listChannels(env),
    listSources(env),
    loadSettings(env),
    listLineOverrides(env),
    listLineFavorites(env),
  ]);
  const favoriteSet = new Set(favorites);
  const channelMap = new Map(channels.map((channel) => [channel.id, channel]));
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const overrideMap = new Map(overrides.map((row) => [row.line_key, row]));
  const byChannel = new Map<string, LineEntry[]>();
  // A URL can be reported by multiple sources; keep the alive/newest record so
  // a stale untested duplicate cannot hide the tested one.
  for (const line of dedupePoolLines(state?.lines ?? [])) {
    const list = byChannel.get(line.channelId) ?? [];
    list.push(line);
    byChannel.set(line.channelId, list);
  }

  const lines: PoolLine[] = [];
  for (const [channelId, list] of byChannel) {
    const channel = channelMap.get(channelId);
    // Channels removed by the empty-channel cleanup still have lines in the
    // state file, but they have no identity/group any more and cannot be
    // published or subscribed. Hide them instead of showing raw x- ids.
    if (!channel) continue;
    const group = channel.group_title ?? '其他';
    const country = countryOfGroup(group);
    const sorted = [...list].sort(compareLines);
    const premiumTarget = settings.maxLinesPerChannel > 0
      ? Math.max(1, Math.min(PREMIUM_PER_CHANNEL, settings.maxLinesPerChannel * 2))
      : Number.MAX_SAFE_INTEGER;
    let premium = 0;
    for (const line of sorted) {
      let autoPool: PoolName;
      if (!line.lastProbeAt) autoPool = 'pending';
      else if (line.status === 'dead') autoPool = 'rejected';
      else if (line.status === 'suspect') autoPool = 'quarantine';
      else if (line.status === 'alive' && !qualityConfirmed(line)) autoPool = 'candidate';
      else if (premium < premiumTarget) {
        autoPool = 'premium';
        premium++;
      } else autoPool = 'backup';
      const override = overrideMap.get(line.key);
      const pool = (override?.pool as PoolName | undefined) ?? autoPool;
      lines.push({
        ...line,
        autoPool,
        pool,
        favorite: favoriteSet.has(line.key),
        overridden: Boolean(override),
        reason: override?.reason ?? undefined,
        transport: line.url.startsWith('https:') ? 'direct' : 'relay',
        channelName: channel.name,
        group,
        country,
        sourceName: sourceMap.get(line.sourceId)?.name ?? line.sourceId,
        sourceReputation: sourceMap.get(line.sourceId)?.reputation ?? 50,
        sourceTier: (sourceMap.get(line.sourceId)?.tier as PoolLine['sourceTier']) ?? 'normal',
        tvgId: channel.tvg_id ?? undefined,
        logo: channel.logo ?? undefined,
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
  const [{ tree }, snapshot] = await Promise.all([
    loadPool(c.env),
    getJson<{ generatedAt?: string; channels?: Record<string, unknown> }>(c.env, 'state/pool.json'),
  ]);
  return ok({
    countries: tree,
    snapshot: {
      generatedAt: snapshot?.generatedAt ?? null,
      channels: snapshot?.channels ? Object.keys(snapshot.channels).length : 0,
    },
  });
});

poolRoutes.get('/pools', async (c) => {
  return ok({ items: await listCustomPools(c.env) });
});

poolRoutes.post('/pools', async (c) => {
  const body = (await readJson<{ name?: unknown }>(c)) ?? {};
  const name = String(body.name ?? '').trim().slice(0, 40);
  if (!name) return fail('请输入池名称');
  const row = await createCustomPool(c.env, `pool-${randomId(8)}`, name);
  if (!row) return fail('已存在同名池', 409);
  await audit(c.env, c.get('actor'), 'pool.create', row.id, { name });
  return ok({ pool: { ...row, count: 0 } }, 201);
});

poolRoutes.patch('/pools/:id', async (c) => {
  const id = c.req.param('id');
  const body = (await readJson<{ name?: unknown }>(c)) ?? {};
  const name = String(body.name ?? '').trim().slice(0, 40);
  if (!name) return fail('请输入池名称');
  const renamed = await renameCustomPool(c.env, id, name);
  if (!renamed) return fail('池不存在或名称重复', 404);
  await audit(c.env, c.get('actor'), 'pool.rename', id, { name });
  return ok({ ok: true });
});

poolRoutes.delete('/pools/:id', async (c) => {
  const id = c.req.param('id');
  const removed = await deleteCustomPool(c.env, id);
  if (!removed) return fail('池不存在', 404);
  await audit(c.env, c.get('actor'), 'pool.delete', id);
  return ok({ ok: true });
});

poolRoutes.post('/pools/:id/lines', async (c) => {
  const id = c.req.param('id');
  const pools = await listCustomPools(c.env);
  if (!pools.some((pool) => pool.id === id)) return fail('池不存在', 404);
  const body = (await readJson<{ keys?: unknown }>(c)) ?? {};
  const keys = Array.isArray(body.keys)
    ? body.keys.filter((key): key is string => typeof key === 'string' && Boolean(key.trim())).slice(0, 2000)
    : [];
  if (!keys.length) return fail('keys 不能为空');
  const added = await addCustomPoolLines(c.env, id, keys);
  await audit(c.env, c.get('actor'), 'pool.lines.add', id, { added });
  return ok({ added });
});

poolRoutes.delete('/pools/:id/lines', async (c) => {
  const id = c.req.param('id');
  const body = (await readJson<{ keys?: unknown }>(c)) ?? {};
  const keys = Array.isArray(body.keys)
    ? body.keys.filter((key): key is string => typeof key === 'string' && Boolean(key.trim())).slice(0, 2000)
    : [];
  if (!keys.length) return fail('keys 不能为空');
  const removed = await removeCustomPoolLines(c.env, id, keys);
  await audit(c.env, c.get('actor'), 'pool.lines.remove', id, { removed });
  return ok({ removed });
});

poolRoutes.get('/lines', async (c) => {
  const { lines } = await loadPool(c.env);
  const country = c.req.query('country') ?? '';
  const group = c.req.query('group') ?? '';
  const channelId = c.req.query('channelId') ?? '';
  const sourceId = c.req.query('sourceId') ?? '';
  const pool = (c.req.query('pool') ?? '') as PoolName | '';
  const transport = c.req.query('transport') ?? '';
  const resolution = c.req.query('resolution') ?? '';
  const minSpeed = Math.max(0, Number(c.req.query('minSpeed') ?? 0) || 0);
  const sortField = (c.req.query('sort') ?? '').trim();
  const sortOrder = c.req.query('order') === 'asc' ? 1 : -1;
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const page = Math.max(1, Number(c.req.query('page') ?? 1) || 1);
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));
  const minRank = resolution ? qualityRank(resolution as Quality) : -1;
  const subscriptionId = (c.req.query('subscriptionId') ?? '').trim();

  const customPoolId = (c.req.query('customPool') ?? '').trim();
  const customPoolKeys = customPoolId ? new Set(await listCustomPoolLineKeys(c.env, customPoolId)) : null;

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
    if (customPoolKeys && !customPoolKeys.has(line.key)) return false;
    if (subscriptionLineKeys && !subscriptionLineKeys.has(line.key)) return false;
    if (!subscriptionLineKeys && subscriptionChannels.length && !subscriptionChannels.includes(line.channelId)) return false;
    if (!subscriptionLineKeys && subscriptionGroups.length && !subscriptionGroups.includes(line.group)) return false;
    if (!subscriptionLineKeys && subscriptionExclude.includes(line.group)) return false;
    if (country && line.country !== country) return false;
    if (group && line.group !== group) return false;
    if (channelId && line.channelId !== channelId) return false;
    if (sourceId && line.sourceId !== sourceId) return false;
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

  const poolRank: Record<string, number> = { premium: 0, backup: 1, candidate: 2, pending: 3, quarantine: 4, rejected: 5 };
  const statusRank: Record<string, number> = { alive: 0, unknown: 1, suspect: 2, dead: 3 };
  const sortValue = (line: PoolLine): string | number | null => {
    switch (sortField) {
      case 'channel': return line.channelName;
      case 'source': return line.sourceName;
      case 'resolution': return qualityRank(qualityOf(line));
      case 'speed': return line.speedKbps ?? null;
      case 'transport': return line.transport;
      case 'pool': return poolRank[line.pool] ?? 9;
      case 'status': return statusRank[line.status] ?? 9;
      case 'probe': return line.lastProbeAt ? Date.parse(line.lastProbeAt) : null;
      default: return null;
    }
  };
  if (sortField) {
    filtered.sort((a, b) => {
      const av = sortValue(a);
      const bv = sortValue(b);
      if (av === null && bv === null) return compareLines(a, b);
      if (av === null) return 1;
      if (bv === null) return -1;
      const cmp = typeof av === 'string' && typeof bv === 'string'
        ? av.localeCompare(bv, 'zh-CN')
        : Number(av) - Number(bv);
      return cmp * sortOrder || compareLines(a, b);
    });
  } else {
    filtered.sort(
      (a, b) =>
        a.country.localeCompare(b.country, 'zh-CN') ||
        a.group.localeCompare(b.group, 'zh-CN') ||
        a.channelName.localeCompare(b.channelName, 'zh-CN') ||
        compareLines(a, b),
    );
  }
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
      sourceReputation: line.sourceReputation,
      sourceTier: line.sourceTier,
      name: line.name,
      url: line.url,
      resolution: line.resolution,
      height: line.height,
      speedKbps: line.speedKbps,
      protocol: line.protocol,
      transport: line.transport,
      pool: line.pool,
      autoPool: line.autoPool,
      favorite: line.favorite,
      overridden: line.overridden,
      promoted: line.promoted,
      reason: line.reason,
      status: line.status,
      score: line.score,
      passCount: line.passCount,
      lastProbeAt: line.lastProbeAt,
      retained: line.retained ?? false,
    })),
  });
});

const VALID_POOLS = new Set(['premium', 'backup', 'candidate', 'pending', 'quarantine', 'rejected']);

poolRoutes.get('/favorites', async (c) => {
  return ok({ keys: await listLineFavorites(c.env) });
});

poolRoutes.post('/favorite', async (c) => {
  const body = (await readJson<{ keys?: unknown; favorite?: unknown }>(c)) ?? {};
  const keys = Array.isArray(body.keys) ? body.keys.filter((key): key is string => typeof key === 'string').slice(0, 500) : [];
  if (!keys.length) return fail('keys 不能为空');
  const favorite = body.favorite !== false;
  await setLineFavorite(c.env, keys, favorite);
  await audit(c.env, c.get('actor'), favorite ? 'pool.favorite' : 'pool.unfavorite', 'bulk', { keys });
  return ok({ ok: true, count: keys.length });
});

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

poolRoutes.get('/tombstones', async (c) => {
  const items = await listLineTombstones(c.env);
  return ok({ items, urls: items.map((item) => item.url) });
});

/** Delete lines without a tombstone; a source refresh may bring them back. */
poolRoutes.post('/delete', async (c) => {
  const body = (await readJson<{ keys?: unknown }>(c)) ?? {};
  const keys = Array.isArray(body.keys) ? body.keys.filter((key): key is string => typeof key === 'string').slice(0, 200) : [];
  if (!keys.length) return fail('keys 不能为空');
  const removed = await removeLinesFromArtifacts(c.env, new Set(keys));
  await deleteLineOverrides(c.env, keys);
  await audit(c.env, c.get('actor'), 'pool.delete', 'bulk', { keys, removed });
  return ok({ removed });
});

/** Delete + permanent tombstone so the URL can never be re-imported. */
poolRoutes.post('/tombstone', async (c) => {
  const body = (await readJson<{ keys?: unknown; urls?: unknown; reason?: unknown }>(c)) ?? {};
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 200) : null;
  // URLs can be tombstoned without deleting the line; keys remove + tombstone.
  const urls = Array.isArray(body.urls)
    ? body.urls.filter((url): url is string => typeof url === 'string' && Boolean(url.trim())).slice(0, 500)
    : [];
  if (urls.length) {
    const tombstoned = await addLineTombstones(c.env, urls.map((url) => ({ url: canonicalPoolUrl(url), reason })));
    await audit(c.env, c.get('actor'), 'pool.tombstone', 'urls', { urls, tombstoned, reason });
    return ok({ tombstoned, removed: 0 });
  }

  const keys = Array.isArray(body.keys) ? body.keys.filter((key): key is string => typeof key === 'string').slice(0, 200) : [];
  if (!keys.length) return fail('keys 或 urls 不能为空');
  const state = await loadLines(c.env);
  const selected = (state?.lines ?? []).filter((line) => keys.includes(line.key));
  if (!selected.length) return fail('线路不存在或已被删除', 404);
  const tombstoned = await addLineTombstones(
    c.env,
    selected.map((line) => ({ url: canonicalPoolUrl(line.url), lineKey: line.key, channelId: line.channelId, reason })),
  );
  const removed = await removeLinesFromArtifacts(c.env, new Set(selected.map((line) => line.key)));
  await deleteLineOverrides(c.env, selected.map((line) => line.key));
  await audit(c.env, c.get('actor'), 'pool.tombstone', 'bulk', { keys, tombstoned, removed, reason });
  return ok({ tombstoned, removed });
});

poolRoutes.post('/untombstone', async (c) => {
  const body = (await readJson<{ urls?: unknown }>(c)) ?? {};
  const urls = Array.isArray(body.urls) ? body.urls.filter((url): url is string => typeof url === 'string' && Boolean(url.trim())).slice(0, 500) : [];
  if (!urls.length) return fail('urls 不能为空');
  // Tombstones are stored canonicalised; canonicalise lookups too, otherwise a
  // case/slash/trailing-? difference silently fails to lift the tombstone.
  const canonical = urls.map((url) => canonicalPoolUrl(url));
  const removed = await removeLineTombstones(c.env, canonical);
  await audit(c.env, c.get('actor'), 'pool.untombstone', 'bulk', { urls, removed });
  return ok({ removed });
});

/** 一次性迁移：旧待复测（失败≥2 次）改判已淘汰；已淘汰补 rejectedAt 并清掉旧 reviveAt。 */
poolRoutes.post('/migrate-rejected', async (c) => {
  const state = await loadLines(c.env);
  if (!state?.lines?.length) return fail('当前没有线路池', 404);
  const generatedAt = new Date().toISOString();
  let rejected = 0;
  let cleared = 0;
  for (const line of state.lines) {
    const legacy = line as LineEntry & { reviveAt?: string };
    if (legacy.reviveAt) {
      delete legacy.reviveAt;
      cleared++;
    }
    if (line.status === 'dead') {
      if (!line.rejectedAt) {
        line.rejectedAt = line.lastProbeAt ?? generatedAt;
        rejected++;
      }
      continue;
    }
    if (line.status === 'suspect') {
      const everAlive = line.everAlive ?? (line.passCount ?? 0) > 0;
      const threshold = everAlive ? 3 : 2;
      if (Number(line.failCount ?? 0) >= threshold) {
        line.status = 'dead';
        line.rejectedAt = generatedAt;
        rejected++;
      }
    }
  }
  if (rejected || cleared) {
    await saveLines(c.env, state.lines, generatedAt);
  }
  await audit(c.env, c.get('actor'), 'pool.migrate-rejected', 'bulk', { rejected, cleared, total: state.lines.length });
  return ok({ rejected, cleared, total: state.lines.length });
});

/** 复活已淘汰线路：按 keys 或整源拉回待测，立即派发前 50 条探测。 */
poolRoutes.post('/revive', async (c) => {
  const body = (await readJson<{ keys?: unknown; sourceId?: unknown; limit?: unknown }>(c)) ?? {};
  const keys = Array.isArray(body.keys)
    ? body.keys.filter((key): key is string => typeof key === 'string' && Boolean(key.trim())).slice(0, 1000)
    : [];
  const sourceId = typeof body.sourceId === 'string' ? body.sourceId.trim().slice(0, 120) : '';
  const limit = Math.max(1, Math.min(1000, Number(body.limit) || 500));
  if (!keys.length && !sourceId) return fail('keys 或 sourceId 不能为空');
  const state = await loadLines(c.env);
  if (!state?.lines?.length) return fail('当前没有线路池', 404);
  const selected = state.lines
    .filter((line) => line.status === 'dead' && (keys.includes(line.key) || (sourceId && line.sourceId === sourceId)))
    .slice(0, limit);
  if (!selected.length) return fail('没有可复活的已淘汰线路', 404);
  const generatedAt = new Date().toISOString();
  for (const line of selected) {
    line.status = 'unknown';
    line.failCount = 0;
    line.lastProbeAt = undefined;
    delete line.rejectedAt;
  }
  await saveLines(c.env, state.lines, generatedAt);
  const probeKeys = selected.slice(0, 50).map((line) => line.key);
  const task = await createTask(c.env, {
    type: 'probe-lines',
    source: 'manual',
    priority: 100,
    payload: { line_keys: probeKeys.join(','), budget: '0', force: 'false', source_id: '', phase: '' },
    total: selected.length,
    unit: 'lines',
  });
  const dispatched = await dispatchNext(c.env);
  await audit(c.env, c.get('actor'), 'pool.revive', 'bulk', { revived: selected.length, sourceId, taskId: task.id });
  return ok({ revived: selected.length, taskId: task.id, dispatched: Boolean(dispatched.task) });
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
  const sourceId = String(body.sourceId ?? '');
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
    if (sourceId && line.sourceId !== sourceId) return false;
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
  const sourceId = String(body.sourceId ?? '');
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
    if (sourceId && line.sourceId !== sourceId) return false;
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
    pool_ids: '[]',
    filter_mode: 'inherit',
    proxy_mode: 'direct',
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

/**
 * Lines whose source row was deleted stay in state/lines.json until the
 * retention sweep removes them. Deleting a broken source should not keep its
 * lines exportable for LINE_RETENTION_DAYS, so the pool page offers a targeted
 * cleanup instead of waiting for the sweeper.
 */
poolRoutes.get('/orphans', async (c) => {
  const [state, sources] = await Promise.all([
    loadLines(c.env),
    listSources(c.env),
  ]);
  const live = new Set(sources.map((source) => source.id));
  const groups = new Map<string, { count: number; alive: number; sample: string }>();
  let aliveKept = 0;
  for (const line of state?.lines ?? []) {
    if (live.has(line.sourceId)) continue;
    const group = groups.get(line.sourceId) ?? { count: 0, alive: 0, sample: line.url };
    if (line.status === 'alive') {
      // A working stream outlives its playlist: do not offer usable lines to
      // the one-click cleanup just because the source row is gone.
      group.alive++;
      aliveKept++;
    } else {
      group.count++;
    }
    groups.set(line.sourceId, group);
  }
  const items = [...groups.entries()]
    .filter(([, group]) => group.count > 0)
    .map(([sourceId, group]) => ({ sourceId, count: group.count, alive: group.alive, sample: group.sample }));
  return ok({ total: items.reduce((sum, item) => sum + item.count, 0), aliveKept, items });
});

poolRoutes.post('/orphans/cleanup', async (c) => {
  const body = await readJson<{ sourceId?: string; includeAlive?: boolean }>(c);
  const [state, sources] = await Promise.all([
    loadLines(c.env),
    listSources(c.env),
  ]);
  const live = new Set(sources.map((source) => source.id));
  const keys = new Set(
    (state?.lines ?? [])
      .filter((line) => !live.has(line.sourceId)
        && (body?.includeAlive === true || line.status !== 'alive')
        && (!body?.sourceId || line.sourceId === body.sourceId))
      .map((line) => line.key),
  );
  if (!keys.size) return ok({ removed: 0 });
  const removed = await removeLinesFromArtifacts(c.env, keys);
  await audit(c.env, c.get('actor'), 'pool.cleanup_orphans', body?.sourceId ?? 'all', { removed, sourceId: body?.sourceId ?? null });
  return ok({ removed });
});

/**
 * Diagnostic: status/age breakdown of state/lines.json without downloading the
 * 19MB artifact. Used by the capacity/archive work to see whether dead lines
 * are old enough to archive.
 */
poolRoutes.get('/line-stats', async (c) => {
  const state = await loadLines(c.env);
  const lines = state?.lines ?? [];
  const now = Date.now();
  const cutoff = now - 30 * 86_400_000;
  const byStatus: Record<string, number> = {};
  const byProtocol: Record<string, number> = {};
  let deadOld = 0;
  let deadNoStamp = 0;
  let suspectOld = 0;
  for (const line of lines) {
    const status = line.status ?? 'unknown';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    const protocol = line.protocol ?? 'unknown';
    byProtocol[protocol] = (byProtocol[protocol] ?? 0) + 1;
    if (line.status === 'dead') {
      const stamp = Date.parse(line.lastProbeAt ?? line.rejectedAt ?? '');
      if (!Number.isFinite(stamp)) deadNoStamp++;
      else if (stamp < cutoff) deadOld++;
    } else if (line.status === 'suspect') {
      const stamp = Date.parse(line.lastProbeAt ?? '');
      if (Number.isFinite(stamp) && stamp < cutoff) suspectOld++;
    }
  }
  return ok({
    total: lines.length,
    bytes: JSON.stringify(state ?? { lines: [] }).length,
    generatedAt: state?.generatedAt ?? null,
    byStatus,
    byProtocol,
    deadOld,
    deadNoStamp,
    suspectOld,
  });
});
