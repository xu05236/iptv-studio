import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import {
  createSubscription,
  createSubscriptionToken,
  deleteSubscription,
  deleteSubscriptionToken,
  getSubscription,
  listSubscriptionTokens,
  listSubscriptions,
  setSubscriptionTokenEnabled,
  updateSubscription,
  audit,
  type SubscriptionRow,
} from '../db.js';
import { fail, ok, randomId, randomToken, readJson, toStringList } from '../lib/http.js';
import { channelMatches, renderSubscription, subscriptionFromRow, type SubscriptionConfig } from '../lib/playlist.js';
import { loadCatalog } from '../lib/catalog.js';
import { extensionFor } from '@iptv/core';

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

const PROXY_MODES = ['direct', 'playlist', 'full'];
function proxyModeOf(value: unknown): string {
  return typeof value === 'string' && PROXY_MODES.includes(value) ? value : 'direct';
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
    line_keys: JSON.stringify(toStringList(input['lineKeys'] ?? input['line_keys'])),
    pool_mode: String(input['poolMode'] ?? input['pool_mode'] ?? 'premium'),
    proxy_mode: proxyModeOf(input['proxyMode'] ?? input['proxy_mode']),
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
  const rawMode = patch['proxyMode'] ?? patch['proxy_mode'];
  if (rawMode !== undefined && proxyModeOf(rawMode) === 'direct' && rawMode !== 'direct') {
    return fail('代理模式不合法（direct / playlist / full）');
  }
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

subscriptionRoutes.get('/:id/tokens', async (c) => {
  const id = c.req.param('id');
  const row = await getSubscription(c.env, id);
  if (!row) return fail('订阅不存在', 404);
  const items = await listSubscriptionTokens(c.env, id);
  return ok({ items });
});

subscriptionRoutes.post('/:id/tokens', async (c) => {
  const id = c.req.param('id');
  const row = await getSubscription(c.env, id);
  if (!row) return fail('订阅不存在', 404);
  const body = (await readJson<{ label?: string }>(c)) ?? {};
  const label = String(body.label ?? '').trim() || `设备 ${new Date().toISOString().slice(5, 10)}`;
  const tokenRow = await createSubscriptionToken(c.env, id, label);
  await audit(c.env, c.get('actor'), 'subscription.token.create', id, { label });
  return ok({ token: tokenRow, url: `${baseUrl(c)}/sub/${tokenRow.token}.m3u` }, 201);
});

subscriptionRoutes.patch('/:id/tokens/:token', async (c) => {
  const id = c.req.param('id');
  const body = (await readJson<{ enabled?: boolean }>(c)) ?? {};
  if (typeof body.enabled !== 'boolean') return fail('缺少 enabled');
  const updated = await setSubscriptionTokenEnabled(c.env, id, c.req.param('token'), body.enabled);
  if (!updated) return fail('令牌不存在', 404);
  await audit(c.env, c.get('actor'), 'subscription.token.toggle', id, { token: c.req.param('token').slice(0, 6), enabled: body.enabled });
  return ok({ ok: true });
});

subscriptionRoutes.delete('/:id/tokens/:token', async (c) => {
  const id = c.req.param('id');
  const removed = await deleteSubscriptionToken(c.env, id, c.req.param('token'));
  if (!removed) return fail('令牌不存在', 404);
  await audit(c.env, c.get('actor'), 'subscription.token.delete', id, { token: c.req.param('token').slice(0, 6) });
  return ok({ ok: true });
});

subscriptionRoutes.get('/:id/preview', async (c) => {
  const id = c.req.param('id');
  const row = await getSubscription(c.env, id);
  if (!row) return fail('订阅不存在', 404);

  const config = subscriptionFromRow(row);
  const format = (c.req.query('format') as SubscriptionConfig['format']) ?? config.format;
  config.format = format;

  // Preview must use the exact same renderer as the live subscription URL.
  // The old preview used catalog + a hardcoded per-source cap, so it reported
  // far fewer lines than the real M3U.
  const rendered = await renderSubscription(c.env, config, baseUrl(c));
  if (!rendered) return fail('尚未生成频道数据，请先运行采集任务', 409);

  return ok({
    format,
    etag: rendered.etag,
    channels: rendered.channels,
    lines: rendered.lines,
    matched: rendered.channels,
    preview: rendered.body.slice(0, 40_000),
  });
});
