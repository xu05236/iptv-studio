import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv } from '../env.js';
import { fail, hashIp, intParam, ok, randomId, readJson } from '../lib/http.js';
import { loadChannelShard, loadGuide, loadIndex } from '../lib/catalog.js';
import { countOpenFeedback, getChannel, insertFeedback, listRuns, listSources, loadSettings } from '../db.js';
import { sourceMetaMap } from '../lib/source.js';

export const publicRoutes = new Hono<AppEnv>();

publicRoutes.use('*', cors());

const CACHE_30 = { 'cache-control': 'public, max-age=30, s-maxage=60' } as const;

publicRoutes.get('/overview', async (c) => {
  const [index, runs, openFeedback, settings] = await Promise.all([
    loadIndex(c.env),
    listRuns(c.env, 3),
    countOpenFeedback(c.env),
    loadSettings(c.env),
  ]);

  if (!index) {
    return ok(
      {
        ready: false,
        message: '尚未生成频道数据，请在管理后台触发一次采集',
        totals: { channels: 0, lines: 0, alive: 0 },
        groups: [],
      },
      200,
      CACHE_30,
    );
  }

  return ok(
    {
      ready: true,
      generatedAt: index.generatedAt,
      runId: index.runId,
      totals: {
        channels: index.totalChannels,
        lines: index.totalLines,
        alive: index.aliveLines,
        dead: Math.max(0, index.totalLines - index.aliveLines),
      },
      groups: index.groups,
      lastRun: runs[0] ?? null,
      openFeedback,
      features: { relay: settings.relayEnabled },
    },
    200,
    CACHE_30,
  );
});

publicRoutes.get('/channels', async (c) => {
  const index = await loadIndex(c.env);
  if (!index) return ok({ items: [], total: 0, ready: false }, 200, CACHE_30);

  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const group = c.req.query('group');
  const page = intParam(c.req.query('page'), 1, 1, 10_000);
  const limit = intParam(c.req.query('limit'), 60, 1, 500);

  let rows = index.channels;
  if (group && group !== '全部') rows = rows.filter((item) => item.group === group);
  if (q) rows = rows.filter((item) => item.name.toLowerCase().includes(q) || item.id.includes(q) || (item.tvgId ?? '').toLowerCase().includes(q));

  const start = (page - 1) * limit;
  return ok(
    {
      items: rows.slice(start, start + limit),
      total: rows.length,
      page,
      limit,
      groups: index.groups,
      ready: true,
    },
    200,
    CACHE_30,
  );
});

publicRoutes.get('/channels/:id', async (c) => {
  const id = c.req.param('id');
  const settings = await loadSettings(c.env);
  const shard = await loadChannelShard(c.env, id);
  if (shard) {
    // Never expose the real line URL or request headers to the public browser:
    // preview goes through /relay/line/<key>, admin APIs keep the full record.
    const sources = await listSources(c.env);
    const meta = sourceMetaMap(sources);
    const safeLines = shard.lines.map(({ url: _url, headers: _headers, ...rest }) => ({
      ...rest,
      sourceName: meta.get(rest.sourceId)?.name ?? rest.sourceId,
      sourceSite: meta.get(rest.sourceId)?.site ?? '未知来源',
    }));
    return ok(
      {
        channel: shard.channel,
        lines: safeLines,
        epg: shard.epg ?? null,
        features: { relay: settings.relayEnabled },
      },
      200,
      CACHE_30,
    );
  }
  const channel = await getChannel(c.env, id);
  if (!channel) return fail('频道不存在', 404);
  return ok(
    {
      channel: { id: channel.id, name: channel.name, group: channel.group_title ?? '其他', tvgId: channel.tvg_id ?? undefined, logo: channel.logo ?? undefined },
      lines: [],
      epg: null,
      features: { relay: settings.relayEnabled },
    },
    200,
    CACHE_30,
  );
});

publicRoutes.get('/guide', async (c) => {
  const guide = await loadGuide(c.env);
  if (!guide) return ok({ generatedAt: null, channels: {} }, 200, CACHE_30);
  return ok(guide, 200, CACHE_30);
});

publicRoutes.post('/feedback', async (c) => {
  const body = await readJson<{
    entryKey?: string;
    channelId?: string;
    sourceId?: string;
    kind?: string;
    message?: string;
  }>(c);
  if (!body || (!body.channelId && !body.entryKey)) return fail('缺少频道或线路标识');

  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';
  const reporter = hashIp(ip);
  const key = `fb:${reporter}`;
  const count = Number((await c.env.KV.get(key)) ?? '0');
  if (count >= 20) return fail('反馈过于频繁，请稍后再试', 429);
  await c.env.KV.put(key, String(count + 1), { expirationTtl: 3600 });

  const id = `fb-${randomId(10)}`;
  await insertFeedback(c.env, {
    id,
    entry_key: body.entryKey ?? null,
    channel_id: body.channelId ?? null,
    source_id: body.sourceId ?? null,
    kind: (body.kind ?? 'dead').slice(0, 20),
    message: (body.message ?? '').slice(0, 500) || null,
    reporter_hash: reporter,
    status: 'open',
    created_at: new Date().toISOString(),
  });

  return ok({ ok: true, id }, 201);
});
