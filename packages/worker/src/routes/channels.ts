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
