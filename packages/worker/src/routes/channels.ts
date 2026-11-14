import { Hono } from 'hono';
import { classifyGroup, displayName, normalizeChannelName } from '@iptv/core';
import type { AppEnv } from '../env.js';
import { loadTasks } from '../lib/tasks.js';
import {
  addAlias,
  channelAliases,
  deleteChannel,
  getChannel,
  listChannels,
  listChannelMerges,
  listSources,
  mergeChannels,
  removeAlias,
  undoChannelMerge,
  updateChannel,
  audit,
} from '../db.js';
import { fail, ok, readJson } from '../lib/http.js';
import { loadChannelShard, loadIndex } from '../lib/catalog.js';
import { loadLines } from '../lib/linesState.js';
import { sourceMetaMap } from '../lib/source.js';
import { countryOfGroup, countryRank } from '../lib/channelCountry.js';
import type { ChannelRow } from '../db.js';

export const channelRoutes = new Hono<AppEnv>();

/** Recent merges, newest first; the merge sheet offers undo for these. */
channelRoutes.get('/merges', async (c) => {
  const items = await listChannelMerges(c.env, 10);
  return ok({ items });
});

channelRoutes.post('/merges/:id/undo', async (c) => {
  const id = c.req.param('id');
  const result = await undoChannelMerge(c.env, id);
  if (!result) return fail('合并记录不存在或已撤销', 404);
  await audit(c.env, c.get('actor'), 'channel.merge.undo', id, result);
  return ok(result);
});

channelRoutes.get('/alias-conflicts', async (c) => {
  const [{ results: aliasRows }, channels] = await Promise.all([
    c.env.DB.prepare('SELECT alias, channel_id FROM aliases').all<{ alias: string; channel_id: string }>(),
    listChannels(c.env),
  ]);
  const names = new Map(channels.map((channel) => [channel.id, channel.name]));
  const canonical = new Map<string, string[]>();
  for (const channel of channels) {
    const key = normalizeChannelName(channel.name);
    if (!key) continue;
    const list = canonical.get(key) ?? [];
    list.push(channel.id);
    canonical.set(key, list);
  }

  const grouped = new Map<string, { aliases: Set<string>; channelIds: Set<string> }>();
  for (const row of aliasRows) {
    const key = normalizeChannelName(row.alias);
    if (!key) continue;
    const entry = grouped.get(key) ?? { aliases: new Set<string>(), channelIds: new Set<string>() };
    entry.aliases.add(row.alias);
    entry.channelIds.add(row.channel_id);
    for (const id of canonical.get(key) ?? []) entry.channelIds.add(id);
    grouped.set(key, entry);
  }

  const items = [...grouped.entries()]
    .filter(([, entry]) => entry.channelIds.size > 1)
    .map(([normalized, entry]) => ({
      normalized,
      aliases: [...entry.aliases],
      channels: [...entry.channelIds].map((id) => ({ id, name: names.get(id) ?? id })),
    }))
    .sort((a, b) => b.channels.length - a.channels.length)
    .slice(0, 100);

  return ok({ items, total: items.length });
});

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

  const sortRows = await c.env.DB.prepare('SELECT id, sort FROM channels WHERE sort IS NOT NULL AND sort <> 0').all<{ id: string; sort: number }>();
  const sortMap = new Map(sortRows.results.map((row) => [row.id, row.sort]));

  const filtered = index.channels
    .filter((channel) => {
      const channelGroup = channel.group?.trim() || '其他';
      if (group && channelGroup !== group) return false;
      if (!group && groups.length && !groups.includes(channelGroup)) return false;
      if (country && countryOfGroup(channelGroup) !== country) return false;
      if (q && !channel.name.toLowerCase().includes(q) && !channel.id.includes(q)) return false;
      return true;
    })
    .sort((a, b) => {
      const left = sortMap.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const right = sortMap.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      if (left !== right) return left - right;
      return a.group.localeCompare(b.group) || a.name.localeCompare(b.name);
    });

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

channelRoutes.post('/reorder', async (c) => {
  const body = await readJson<{ ids?: string[]; start?: number }>(c);
  const ids = (Array.isArray(body?.ids) ? body.ids : []).filter((id): id is string => typeof id === 'string').slice(0, 500);
  if (!ids.length) return fail('缺少频道 id');
  const start = Math.max(1, Number(body?.start) || 1);
  for (let offset = 0; offset < ids.length; offset += 40) {
    const chunk = ids.slice(offset, offset + 40);
    await c.env.DB.batch(
      chunk.map((id, index) =>
        c.env.DB.prepare("UPDATE channels SET sort = ?, updated_at = datetime('now') WHERE id = ?").bind(start + offset + index, id),
      ),
    );
  }
  await audit(c.env, c.get('actor'), 'channels.reorder', 'channels', { count: ids.length, start });
  return ok({ updated: ids.length });
});

channelRoutes.post('/rename-batch', async (c) => {
  const body = await readJson<{ ids?: string[]; find?: string; replace?: string }>(c);
  const ids = (Array.isArray(body?.ids) ? body.ids : []).filter((id): id is string => typeof id === 'string').slice(0, 300);
  const find = String(body?.find ?? '').trim();
  const replace = String(body?.replace ?? '');
  if (!ids.length) return fail('缺少频道 id');
  if (!find) return fail('缺少要查找的文字');
  if (find.length > 40 || replace.length > 80) return fail('查找/替换文字过长');
  let updated = 0;
  for (let offset = 0; offset < ids.length; offset += 40) {
    const chunk = ids.slice(offset, offset + 40);
    const results = (await c.env.DB.batch(
      chunk.map((id) =>
        c.env.DB.prepare("UPDATE channels SET name = replace(name, ?, ?), updated_at = datetime('now') WHERE id = ? AND instr(name, ?) > 0").bind(
          find,
          replace,
          id,
          find,
        ),
      ),
    )) as unknown as Array<{ meta?: { changes?: number } }>;
    updated += results.reduce((sum, result) => sum + Number(result.meta?.changes ?? 0), 0);
  }
  await audit(c.env, c.get('actor'), 'channels.rename_batch', 'channels', { count: updated, find });
  return ok({ updated });
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

channelRoutes.post('/cleanup-empty', async (c) => {
  const index = await loadIndex(c.env);
  if (!index) return fail('频道索引尚未生成', 409);
  const active = new Set(index.channels.map((channel) => channel.id));
  const state = await loadLines(c.env);
  const referenced = new Set(state.lines.map((line) => line.channelId));
  const channels = await listChannels(c.env);
  const { results: aliasRows } = await c.env.DB.prepare(
    'SELECT channel_id, alias FROM aliases',
  ).all<{ channel_id: string; alias: string }>();
  const aliases = new Map<string, string[]>();
  for (const row of aliasRows) {
    const list = aliases.get(row.channel_id) ?? [];
    list.push(row.alias);
    aliases.set(row.channel_id, list);
  }

  // Auto-created aliases (name/tvg id) do not count as user data. Only keep a
  // stale channel when it has an additional, manually added alias.
  const candidates = channels.filter((channel) => {
    if (active.has(channel.id)) return false;
    if (referenced.has(channel.id)) return false;
    const list = aliases.get(channel.id) ?? [];
    return list.every((alias) => alias === channel.name || alias === channel.tvg_id);
  });
  const statements: D1PreparedStatement[] = [];
  for (const channel of candidates) {
    statements.push(c.env.DB.prepare('DELETE FROM aliases WHERE channel_id = ?').bind(channel.id));
    statements.push(c.env.DB.prepare('DELETE FROM channels WHERE id = ?').bind(channel.id));
  }
  for (let offset = 0; offset < statements.length; offset += 50) {
    await c.env.DB.batch(statements.slice(offset, offset + 50));
  }
  await audit(c.env, c.get('actor'), 'channel.cleanup_empty', 'all', { deleted: candidates.length, active: active.size });
  return ok({ deleted: candidates.length, kept: channels.length - candidates.length, active: active.size });
});

channelRoutes.post('/ensure', async (c) => {
  const body = (await readJson<{ items?: Array<{ id?: string; name?: string; group?: string }> }>(c)) ?? {};
  const items = (body.items ?? [])
    .filter((item) => typeof item.id === 'string' && item.id.trim().startsWith('x-') && typeof item.name === 'string' && item.name.trim())
    .slice(0, 20000)
    .map((item) => ({ id: item.id!.trim(), name: item.name!.trim().slice(0, 120), group: (item.group ?? '').trim().slice(0, 60) || '其他' }));
  if (!items.length) return ok({ total: 0 });
  // Read current rows first and upsert only new/changed channels: publishers call
  // this on every publish and an unconditional UPSERT would rewrite unchanged
  // rows, burning D1 writes for nothing.
  const existing = new Map<string, { name: string; group_title: string | null }>();
  for (let offset = 0; offset < items.length; offset += 40) {
    const chunk = items.slice(offset, offset + 40);
    const { results } = await c.env.DB.prepare(
      `SELECT id, name, group_title FROM channels WHERE id IN (${chunk.map(() => '?').join(', ')})`,
    ).bind(...chunk.map((item) => item.id)).all<{ id: string; name: string; group_title: string | null }>();
    for (const row of results) existing.set(row.id, row);
  }
  const changed = items.filter((item) => {
    const row = existing.get(item.id);
    return !row || row.name !== item.name || (row.group_title ?? '') !== item.group;
  });
  // One UPSERT per channel, batched into D1 `batch` calls. Sequential writes
  // take tens of seconds for a few thousand channels and time the publisher out.
  const statements = changed.map((item) =>
    c.env.DB.prepare(
      "INSERT INTO channels (id, name, group_title, enabled, updated_at) VALUES (?, ?, ?, 1, datetime('now')) ON CONFLICT(id) DO UPDATE SET name = excluded.name, group_title = excluded.group_title, updated_at = datetime('now')",
    ).bind(item.id, item.name, item.group),
  );
  for (let offset = 0; offset < statements.length; offset += 50) {
    await c.env.DB.batch(statements.slice(offset, offset + 50));
  }
  await audit(c.env, c.get('actor'), 'channel.ensure', 'bulk', { total: changed.length, skipped: items.length - changed.length });
  return ok({ total: changed.length, skipped: items.length - changed.length });
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

/** Bulk enable/disable channels, used by cleanup batches and whole-group toggles. */
channelRoutes.post('/bulk-enabled', async (c) => {
  const body = (await readJson<{ ids?: string[]; group?: string; enabled?: boolean }>(c)) ?? {};
  const enabled = body.enabled === false ? 0 : 1;
  const group = typeof body.group === 'string' ? body.group.trim() : '';
  let ids = (body.ids ?? []).filter((id): id is string => typeof id === 'string' && Boolean(id.trim())).slice(0, 5000);
  if (!ids.length && group) {
    const { results } = await c.env.DB.prepare(
      'SELECT id FROM channels WHERE group_title = ? AND enabled != ? LIMIT 5000',
    ).bind(group, enabled).all<{ id: string }>();
    ids = results.map((row) => row.id);
  }
  if (!ids.length) return fail(group ? '该分组没有需要修改的频道' : '缺少频道 id');
  const existing = new Map<string, number>();
  for (let offset = 0; offset < ids.length; offset += 40) {
    const chunk = ids.slice(offset, offset + 40);
    const { results } = await c.env.DB.prepare(
      `SELECT id, enabled FROM channels WHERE id IN (${chunk.map(() => '?').join(', ')})`,
    ).bind(...chunk).all<{ id: string; enabled: number }>();
    for (const row of results) existing.set(row.id, row.enabled);
  }
  const changed = ids.filter((id) => existing.has(id) && existing.get(id) !== enabled);
  const statements = changed.map((id) =>
    c.env.DB.prepare("UPDATE channels SET enabled = ?, updated_at = datetime('now') WHERE id = ?").bind(enabled, id),
  );
  for (let offset = 0; offset < statements.length; offset += 50) {
    await c.env.DB.batch(statements.slice(offset, offset + 50));
  }
  await audit(c.env, c.get('actor'), enabled ? 'channel.bulk_enable' : 'channel.bulk_disable', 'bulk', { total: changed.length, requested: ids.length, group: group || null });
  return ok({ total: changed.length, skipped: ids.length - changed.length, enabled: enabled === 1 });
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
  // Merging rewrites the line/probe state. A running fetch or publish would
  // race with that rewrite and could resurrect the channel we just deleted.
  const running = (await loadTasks(c.env)).filter((task) => task.status === 'running');
  if (running.length) {
    const types = [...new Set(running.map((task) => task.type))].join('、');
    return fail(`有任务正在运行（${types}），请等任务结束后再合并频道`, 409);
  }
  const merged = await mergeChannels(c.env, body.from, body.into);
  await audit(c.env, c.get('actor'), 'channel.merge', body.into, { from: body.from, merged });
  return ok({ merged });
});
