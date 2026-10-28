import { Hono } from 'hono';
import { classifyGroup, displayName } from '@iptv/core';
import type { AppEnv } from '../env.js';
import {
  addAlias,
  channelAliases,
  deleteChannel,
  getChannel,
  listChannels,
  listSources,
  mergeChannels,
  removeAlias,
  updateChannel,
  audit,
} from '../db.js';
import { fail, ok, readJson } from '../lib/http.js';
import { loadChannelShard, loadIndex } from '../lib/catalog.js';
import { sourceMetaMap } from '../lib/source.js';
import { countryOfGroup, countryRank } from '../lib/channelCountry.js';
import type { ChannelRow } from '../db.js';

export const channelRoutes = new Hono<AppEnv>();

channelRoutes.get('/meta/aliases', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT alias, channel_id FROM aliases').all<{ alias: string; channel_id: string }>();
  const aliases: Record<string, string> = {};
  for (const row of results) aliases[row.alias] = row.channel_id;
  return ok({ aliases });
});

channelRoutes.get('/', async (c) => {
  const [channels, index, aliasCounts] = await Promise.all([
    listChannels(c.env),
    loadIndex(c.env),
    c.env.DB.prepare('SELECT channel_id, COUNT(*) AS total FROM aliases GROUP BY channel_id').all<{ channel_id: string; total: number }>(),
  ]);

  const stats = new Map((index?.channels ?? []).map((item) => [item.id, item]));
  const aliases = new Map(aliasCounts.results.map((row) => [row.channel_id, row.total]));

  return ok({
    items: channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      group: channel.group_title ?? '其他',
      tvgId: channel.tvg_id,
      logo: channel.logo,
      number: channel.number,
      enabled: channel.enabled === 1,
      sort: channel.sort,
      aliases: aliases.get(channel.id) ?? 0,
      lines: stats.get(channel.id)?.lines ?? 0,
      alive: stats.get(channel.id)?.alive ?? 0,
      bestResolution: stats.get(channel.id)?.bestResolution,
      bestSpeedKbps: stats.get(channel.id)?.bestSpeedKbps ?? 0,
      sources: stats.get(channel.id)?.sources ?? 0,
    })),
    total: channels.length,
    groups: index?.groups ?? [],
  });
});

channelRoutes.post('/reclassify', async (c) => {
  const channels = await listChannels(c.env);
  const targets = channels.filter((channel) => !channel.group_title || channel.group_title === '其他');
  const statements: D1PreparedStatement[] = [];
  for (const channel of targets) {
    const group = classifyGroup(channel.name, channel.group_title);
    if (group === '其他' || group === channel.group_title) continue;
    statements.push(
      c.env.DB.prepare("UPDATE channels SET group_title = ?, updated_at = datetime('now') WHERE id = ?").bind(group, channel.id),
    );
  }
  for (let offset = 0; offset < statements.length; offset += 40) {
    await c.env.DB.batch(statements.slice(offset, offset + 40));
  }
  await audit(c.env, c.get('actor'), 'channel.reclassify', 'all', { fixed: statements.length, scanned: targets.length });
  return ok({ fixed: statements.length, scanned: targets.length });
});

channelRoutes.post('/cleanup-names', async (c) => {
  const channels = await listChannels(c.env);
  const statements: D1PreparedStatement[] = [];
  for (const channel of channels) {
    const cleaned = displayName(channel.name);
    if (!cleaned || cleaned === channel.name) continue;
    statements.push(
      c.env.DB.prepare("UPDATE channels SET name = ?, updated_at = datetime('now') WHERE id = ?").bind(cleaned, channel.id),
    );
  }
  for (let offset = 0; offset < statements.length; offset += 40) {
    await c.env.DB.batch(statements.slice(offset, offset + 40));
  }
  await audit(c.env, c.get('actor'), 'channel.cleanup_names', 'all', { renamed: statements.length });
  return ok({ renamed: statements.length, scanned: channels.length });
});

channelRoutes.get('/meta/tree', async (c) => {
  // Count published channels only: D1 still contains thousands of stale rows
  // from historical imports, which made the admin page enormous.
  const index = await loadIndex(c.env);
  const countries = new Map<string, { country: string; total: number; groups: Array<{ group: string; count: number }> }>();
  for (const channel of index?.channels ?? []) {
    const group = channel.group?.trim() || '其他';
    const country = countryOfGroup(group);
    const entry = countries.get(country) ?? { country, total: 0, groups: [] };
    entry.total++;
    const groupEntry = entry.groups.find((item) => item.group === group);
    if (groupEntry) groupEntry.count++;
    else entry.groups.push({ group, count: 1 });
    countries.set(country, entry);
  }

  return ok({
    total: index?.channels.length ?? 0,
    countries: [...countries.values()]
      .map((entry) => ({ ...entry, groups: entry.groups.sort((a, b) => b.count - a.count) }))
      .sort((a, b) => countryRank(a.country) - countryRank(b.country) || b.total - a.total || a.country.localeCompare(b.country)),
  });
});

channelRoutes.get('/page', async (c) => {
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const group = (c.req.query('group') ?? '').trim();
  const groups = (c.req.query('groups') ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  const country = (c.req.query('country') ?? '').trim();
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100) || 100, 1), 200);
  const offset = Math.max(Number(c.req.query('offset') ?? 0) || 0, 0);

  const index = await loadIndex(c.env);
  if (!index) return ok({ items: [], total: 0, offset, limit });

  const filtered = index.channels
    .filter((channel) => {
      const channelGroup = channel.group?.trim() || '其他';
      if (group && channelGroup !== group) return false;
      if (!group && groups.length && !groups.includes(channelGroup)) return false;
      if (country && countryOfGroup(channelGroup) !== country) return false;
      if (q && !channel.name.toLowerCase().includes(q) && !channel.id.includes(q)) return false;
      return true;
    })
    .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));

  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit);
  const ids = page.map((channel) => channel.id);

  const [rows, aliasRows] = await Promise.all([
    ids.length
      ? c.env.DB.prepare(`SELECT * FROM channels WHERE id IN (${ids.map(() => '?').join(', ')})`).bind(...ids).all<ChannelRow>()
      : Promise.resolve({ results: [] as ChannelRow[] }),
    ids.length
      ? c.env.DB.prepare(
          `SELECT channel_id, COUNT(*) AS total FROM aliases WHERE channel_id IN (${ids.map(() => '?').join(', ')}) GROUP BY channel_id`,
        ).bind(...ids).all<{ channel_id: string; total: number }>()
      : Promise.resolve({ results: [] as Array<{ channel_id: string; total: number }> }),
  ]);
  const rowMap = new Map(rows.results.map((row) => [row.id, row]));
  const aliases = new Map(aliasRows.results.map((row) => [row.channel_id, row.total]));

  return ok({
    items: page.map((channel) => {
      const row = rowMap.get(channel.id);
      const displayGroup = row?.group_title ?? channel.group ?? '其他';
      return {
        id: channel.id,
        name: row?.name ?? channel.name,
        group: displayGroup,
        country: countryOfGroup(displayGroup),
        tvgId: row?.tvg_id ?? channel.tvgId,
        logo: row?.logo ?? channel.logo,
        number: row?.number ?? channel.number,
        enabled: row ? row.enabled === 1 : channel.enabled,
        sort: row?.sort ?? 0,
        aliases: aliases.get(channel.id) ?? 0,
        lines: channel.lines,
        alive: channel.alive,
        bestResolution: channel.bestResolution,
        bestSpeedKbps: channel.bestSpeedKbps ?? 0,
        sources: channel.sources,
      };
    }),
    total,
    offset,
    limit,
  });
});

channelRoutes.post('/bulk-group', async (c) => {
  const body = (await readJson<{ ids?: string[]; group?: string }>(c)) ?? {};
  const ids = [...new Set((body.ids ?? []).filter((id) => typeof id === 'string' && id))].slice(0, 500);
  const group = (body.group ?? '').trim().slice(0, 40);
  if (!ids.length) return fail('请选择频道');
  if (!group) return fail('请填写目标分组');

  const statements: D1PreparedStatement[] = [];
  for (const id of ids) {
    statements.push(
      c.env.DB.prepare("UPDATE channels SET group_title = ?, updated_at = datetime('now') WHERE id = ?").bind(group, id),
    );
  }
  for (let offset = 0; offset < statements.length; offset += 40) {
    await c.env.DB.batch(statements.slice(offset, offset + 40));
  }
  await audit(c.env, c.get('actor'), 'channel.bulk_group', 'bulk', { ids: ids.length, group });
  return ok({ updated: ids.length, group });
});

channelRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const channel = await getChannel(c.env, id);
  if (!channel) return fail('频道不存在', 404);
  const [aliases, shard, sources] = await Promise.all([
    channelAliases(c.env, id),
    loadChannelShard(c.env, id),
    listSources(c.env),
  ]);
  const meta = sourceMetaMap(sources);
  return ok({
    channel,
    aliases,
    lines: (shard?.lines ?? []).map((line) => ({
      ...line,
      sourceName: meta.get(line.sourceId)?.name ?? line.sourceId,
      sourceSite: meta.get(line.sourceId)?.site ?? '未知来源',
    })),
    epg: shard?.epg ?? null,
  });
});

channelRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const channel = await getChannel(c.env, id);
  if (!channel) return fail('频道不存在', 404);
  const patch = (await readJson<Record<string, unknown>>(c)) ?? {};
  const updated = await updateChannel(c.env, id, patch);
  if (!updated) return fail('没有可更新的字段');
  await audit(c.env, c.get('actor'), 'channel.update', id, patch);
  return ok({ channel: await getChannel(c.env, id) });
});

channelRoutes.post('/:id/toggle', async (c) => {
  const id = c.req.param('id');
  const channel = await getChannel(c.env, id);
  if (!channel) return fail('频道不存在', 404);
  await updateChannel(c.env, id, { enabled: channel.enabled !== 1 });
  return ok({ ok: true, enabled: channel.enabled !== 1 });
});

channelRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await deleteChannel(c.env, id);
  await audit(c.env, c.get('actor'), 'channel.delete', id);
  return ok({ ok: true });
});

channelRoutes.post('/:id/aliases', async (c) => {
  const id = c.req.param('id');
  const body = await readJson<{ alias?: string }>(c);
  const alias = body?.alias?.trim();
  if (!alias) return fail('别名不能为空');
  await addAlias(c.env, id, alias);
  return ok({ aliases: await channelAliases(c.env, id) });
});

channelRoutes.post('/:id/aliases/remove', async (c) => {
  const id = c.req.param('id');
  const body = await readJson<{ alias?: string }>(c);
  if (!body?.alias) return fail('别名不能为空');
  await removeAlias(c.env, id, body.alias);
  return ok({ aliases: await channelAliases(c.env, id) });
});

/** Merge duplicate channels (e.g. "CCTV1" and "CCTV-1 综合" discovered twice). */
channelRoutes.post('/merge', async (c) => {
  const body = await readJson<{ from?: string[]; into?: string }>(c);
  if (!body?.into || !Array.isArray(body.from) || !body.from.length) return fail('缺少 from / into');
  const merged = await mergeChannels(c.env, body.from, body.into);
  await audit(c.env, c.get('actor'), 'channel.merge', body.into, { from: body.from, merged });
  return ok({ merged });
});
