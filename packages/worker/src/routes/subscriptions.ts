import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import {
  createSubscription,
  deleteSubscription,
  getSubscription,
  listSubscriptions,
  updateSubscription,
  loadSettings,
  audit,
  type SubscriptionRow,
} from '../db.js';
import { fail, ok, randomId, randomToken, readJson, toStringList } from '../lib/http.js';
import { buildFromCatalog, channelMatches, playlistEtag, subscriptionFromRow, type SubscriptionConfig } from '../lib/playlist.js';
import { loadCatalog } from '../lib/catalog.js';
import { buildPlaylist, selectLines, toExportChannels, extensionFor } from '@iptv/core';

export const subscriptionRoutes = new Hono<AppEnv>();

function baseUrl(c: { req: { url: string }; env: { PUBLIC_BASE_URL?: string } }): string {
  return (c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin).replace(/\/+$/, '');
}

function links(c: { req: { url: string }; env: { PUBLIC_BASE_URL?: string } }, row: SubscriptionRow): Record<string, string> {
  const base = baseUrl(c);
  const out: Record<string, string> = {};
  for (const format of ['m3u', 'txt', 'json', 'diyp'] as const) {
    out[format] = `${base}/sub/${row.token}.${extensionFor(format)}`;
  }
  out['epg'] = `${base}/epg/${row.token}.xml`;
  out['diyp'] = `${base}/sub/${row.token}.json?format=diyp`;
  out['tvbox'] = `${base}/sub/${row.token}.tvbox`;
  return out;
}

function defaults(input: Record<string, unknown>, id: string): SubscriptionRow {
  return {
    id,
    name: String(input['name'] ?? '我的订阅'),
    token: randomToken(),
    enabled: input['enabled'] === false ? 0 : 1,
    groups: JSON.stringify(toStringList(input['groups'])),
    exclude_groups: JSON.stringify(toStringList(input['excludeGroups'] ?? input['exclude_groups'])),
    channel_ids: JSON.stringify(toStringList(input['channelIds'] ?? input['channel_ids'])),
    min_resolution: String(input['minResolution'] ?? input['min_resolution'] ?? 'any'),
    min_speed_kbps: Number(input['minSpeedKbps'] ?? input['min_speed_kbps'] ?? 0),
    protocols: JSON.stringify(toStringList(input['protocols'])),
    max_lines_per_channel: Number(input['maxLinesPerChannel'] ?? 6),
    show_region_suffix: input['showRegionSuffix'] === false ? 0 : 1,
    include_epg: input['includeEpg'] === false ? 0 : 1,
    format: String(input['format'] ?? 'm3u'),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

subscriptionRoutes.get('/', async (c) => {
  const rows = await listSubscriptions(c.env);
  const catalog = await loadCatalog(c.env);
  return ok({
    items: rows.map((row) => {
      const config = subscriptionFromRow(row);
      const matched = catalog ? catalog.items.filter((item) => item.channel.enabled !== false && channelMatches(item.channel, config)).length : 0;
      return {
        ...row,
        groups: JSON.parse(row.groups) as string[],
        excludeGroups: JSON.parse(row.exclude_groups) as string[],
        channelIds: JSON.parse(row.channel_ids) as string[],
        protocols: JSON.parse(row.protocols) as string[],
        enabled: row.enabled === 1,
        showRegionSuffix: row.show_region_suffix === 1,
        includeEpg: row.include_epg === 1,
        matchedChannels: matched,
        links: links(c, row),
      };
    }),
  });
});

subscriptionRoutes.post('/', async (c) => {
  const input = (await readJson<Record<string, unknown>>(c)) ?? {};
  if (!input['name']) return fail('请填写订阅名称');
  const id = `sub-${randomId(8)}`;
  const row = defaults(input, id);
  await createSubscription(c.env, row);
  await audit(c.env, c.get('actor'), 'subscription.create', id, { name: row.name });
  return ok({ subscription: row, links: links(c, row) }, 201);
});

subscriptionRoutes.get('/:id', async (c) => {
  const row = await getSubscription(c.env, c.req.param('id'));
  if (!row) return fail('订阅不存在', 404);
  return ok({ subscription: row, links: links(c, row) });
});

subscriptionRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const row = await getSubscription(c.env, id);
  if (!row) return fail('订阅不存在', 404);
  const patch = (await readJson<Record<string, unknown>>(c)) ?? {};
  const updated = await updateSubscription(c.env, id, patch);
  if (!updated) return fail('没有可更新的字段');
  const next = await getSubscription(c.env, id);
  return ok({ subscription: next, links: next ? links(c, next) : {} });
});

subscriptionRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await deleteSubscription(c.env, id);
  await audit(c.env, c.get('actor'), 'subscription.delete', id);
  return ok({ ok: true });
});

subscriptionRoutes.post('/:id/rotate', async (c) => {
  const id = c.req.param('id');
  const row = await getSubscription(c.env, id);
  if (!row) return fail('订阅不存在', 404);
  await updateSubscription(c.env, id, { token: randomToken() });
  const next = await getSubscription(c.env, id);
  return ok({ subscription: next, links: next ? links(c, next) : {} });
});

subscriptionRoutes.get('/:id/preview', async (c) => {
  const id = c.req.param('id');
  const row = await getSubscription(c.env, id);
  if (!row) return fail('订阅不存在', 404);

  const catalog = await loadCatalog(c.env);
  if (!catalog) return fail('尚未生成频道数据，请先运行采集任务', 409);

  const config = subscriptionFromRow(row);
  const format = (c.req.query('format') as SubscriptionConfig['format']) ?? config.format;
  const settings = await loadSettings(c.env);

  const rows = catalog.items.filter((item) => item.channel.enabled !== false && channelMatches(item.channel, config));
  const selected = rows.map((item) => ({
    channel: item.channel,
    lines: selectLines(item.lines, {
      maxLines: config.maxLinesPerChannel,
      maxPerSource: 3,
      minQuality: config.minResolution,
      minSpeedKbps: config.minSpeedKbps,
      protocols: config.protocols.length ? config.protocols : undefined,
      compensate: true,
      keepSuspect: true,
    }),
  })).filter((item) => item.lines.length > 0);

  const exportChannels = toExportChannels(selected, {
    logoBaseUrl: settings.logoBaseUrl,
    showRegionSuffix: config.showRegionSuffix,
  });
  const body = buildPlaylist(exportChannels, format, {
    epgUrl: config.includeEpg ? `${baseUrl(c)}/epg/${row.token}.xml` : undefined,
    showRegionSuffix: config.showRegionSuffix,
  });

  return ok({
    format,
    etag: playlistEtag(catalog, config),
    channels: exportChannels.length,
    lines: exportChannels.reduce((sum, channel) => sum + channel.lines.length, 0),
    matched: rows.length,
    preview: body.slice(0, 40_000),
  });
});
