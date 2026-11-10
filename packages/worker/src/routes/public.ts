import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv } from '../env.js';
import { fail, hashIp, intParam, ok, randomId, readJson } from '../lib/http.js';
import { loadChannelShard, loadCatalog, loadGuide, loadIndex, loadPoolSnapshot } from '../lib/catalog.js';
import { getJson } from '../lib/store.js';
import { countOpenFeedback, getChannel, insertFeedback, listRuns, listSources, listSubscriptions, loadSettings } from '../db.js';
import { loadTasks } from '../lib/tasks.js';
import { sourceMetaMap } from '../lib/source.js';
import { inferResolution, isPrivateHost, type LineEntry } from '@iptv/core';

export const publicRoutes = new Hono<AppEnv>();

publicRoutes.use('*', cors());

const CACHE_30 = { 'cache-control': 'public, max-age=30, s-maxage=60' } as const;

const LOGO_PROVIDERS = [
  'https://cdn.jsdelivr.net/gh/fanmingming/live@main/tv/',
  'https://fastly.jsdelivr.net/gh/fanmingming/live@main/tv/',
  'https://gcore.jsdelivr.net/gh/fanmingming/live@main/tv/',
  'https://testingcf.jsdelivr.net/gh/fanmingming/live@main/tv/',
  'https://ghproxy.net/https://raw.githubusercontent.com/fanmingming/live/main/tv/',
  'https://gh-proxy.com/https://raw.githubusercontent.com/fanmingming/live/main/tv/',
  'https://cdn.jsdelivr.net/gh/8u8m/live-fanmingming@main/tv/',
  'https://cdn.jsdelivr.net/gh/bxtww/live@main/tv/',
  'https://cdn.jsdelivr.net/gh/bonnie180/live-m3u8@main/tv/',
  'https://cdn.jsdelivr.net/gh/vircloud/TVLogo@main/',
  'https://raw.githubusercontent.com/fanmingming/live/main/tv/',
];

/**
 * Stable logo URL for subscriptions/players: /api/public/logo/CCTV1.png.
 * Tries the same mirrors as the front-end, stores the winning bytes in the
 * Cloudflare cache, and caches 404s briefly so missing ids are cheap.
 */
publicRoutes.get('/logo/:file', async (c) => {
  const file = c.req.param('file');
  const id = file.replace(/\.png$/i, '');
  if (!/^[A-Za-z0-9._+-]{1,64}$/.test(id)) return fail('台标 ID 不合法', 400);

  const cacheKey = new Request(new URL(`/api/public/logo/${file}`, c.req.url).toString(), { method: 'GET' });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  for (const base of LOGO_PROVIDERS) {
    const url = `${base}${encodeURIComponent(id)}.png`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      let upstream: Response;
      try {
        upstream = await fetch(url, {
          signal: controller.signal,
          redirect: 'follow',
          headers: { 'user-agent': 'iptv-studio-logo/1.0' },
        });
      } finally {
        clearTimeout(timer);
      }
      if (!upstream.ok) continue;
      const type = upstream.headers.get('content-type') ?? '';
      if (!type.startsWith('image/')) continue;
      const bytes = await upstream.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > 2 * 1024 * 1024) continue;
      const response = new Response(bytes, {
        status: 200,
        headers: {
          'content-type': type || 'image/png',
          'cache-control': 'public, max-age=604800, immutable',
          'access-control-allow-origin': '*',
        },
      });
      c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch {
      // Try the next mirror.
    }
  }

  const miss = new Response('台标不存在', {
    status: 404,
    headers: { 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' },
  });
  c.executionCtx.waitUntil(cache.put(cacheKey, miss.clone()));
  return miss;
});

publicRoutes.get('/overview', async (c) => {
  const [index, runs, openFeedback, settings, tasks, sources, subscriptions, poolStats] = await Promise.all([
    loadIndex(c.env),
    listRuns(c.env, 5),
    countOpenFeedback(c.env),
    loadSettings(c.env),
    loadTasks(c.env),
    listSources(c.env),
    listSubscriptions(c.env),
    getJson<Record<string, number>>(c.env, 'state/pool-stats.json'),
  ]);

  const taskLabels: Record<string, string> = {
    collect: '全量采集',
    fetch: '抓源',
    'probe-batch': '分批探测',
    'probe-lines': '指定线路探测',
    publish: '发布',
    epg: 'EPG 刷新',
    liveness: '池内测活',
    export: '重建导出',
    snapshot: '快照',
  };
  const latest = runs[0] ?? null;
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const mappedRuns = runs.map((run) => {
    const task = run.task_id ? taskById.get(run.task_id) : undefined;
    return {
      ...run,
      task_type: task?.type ?? null,
      task_label: task ? taskLabels[task.type] ?? task.type : null,
      task_message: task?.message ?? null,
    };
  });
  const lastRun = mappedRuns[0] ?? null;

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
      pool: { total: Number(poolStats?.total ?? 0), alive: Number(poolStats?.alive ?? 0) },
      sources: { total: sources.length, enabled: sources.filter((source) => source.enabled === 1).length },
      subscriptions: subscriptions.length,
      lastRun,
      runs: mappedRuns,
      openFeedback,
      features: { relay: settings.relayEnabled, directPlayback: settings.directPlayback },
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
  const sort = c.req.query('sort') === 'name' ? 'name' : 'availability';
  const page = intParam(c.req.query('page'), 1, 1, 10_000);
  const limit = intParam(c.req.query('limit'), 60, 1, 500);

  let rows = index.channels;
  if (group && group !== '全部') rows = rows.filter((item) => item.group === group);
  if (q) rows = rows.filter((item) => item.name.toLowerCase().includes(q) || item.id.includes(q) || (item.tvgId ?? '').toLowerCase().includes(q));

  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
  rows = [...rows].sort((a, b) =>
    sort === 'name' ? byName(a, b) : b.alive - a.alive || byName(a, b),
  );

  const start = (page - 1) * limit;
  return ok(
    {
      items: rows.slice(start, start + limit),
      total: rows.length,
      page,
      limit,
      sort,
      groups: index.groups,
      ready: true,
    },
    200,
    CACHE_30,
  );
});

publicRoutes.get('/lines/:key/direct', async (c) => {
  const settings = await loadSettings(c.env);
  if (!settings.directPlayback) return fail('直连播放未开启', 403);
  const key = c.req.param('key');
  const probe = await getJson<{ items: Array<{ key: string; url: string }> }>(c.env, 'state/probe.json');
  let url = probe?.items.find((item) => item.key === key)?.url;
  if (!url) {
    const catalog = await loadCatalog(c.env);
    for (const item of catalog?.items ?? []) {
      const line = item.lines.find((candidate) => candidate.key === key);
      if (line) {
        url = line.url;
        break;
      }
    }
  }
  if (!url) return fail('线路不存在', 404);
  return ok({ url }, 200, { 'cache-control': 'no-store' });
});

publicRoutes.get('/channels/:id/relay-check', async (c) => {
  const id = c.req.param('id');
  const cacheKey = `relaycheck:${id}`;
  const cached = await c.env.KV.get<{ items: RelayCheck[] }>(cacheKey, 'json');
  if (cached) return ok(cached, 200, { 'cache-control': 'no-store' });

  const shard = await loadChannelShard(c.env, id);
  if (!shard) return fail('频道不存在', 404);
  const items = await Promise.all(shard.lines.slice(0, 8).map(checkRelayLine));
  const payload = { generatedAt: new Date().toISOString(), items };
  await c.env.KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 300 });
  return ok(payload, 200, { 'cache-control': 'no-store' });
});

interface RelayCheck {
  key: string;
  ok: boolean;
  status: number;
  reason?: string;
  direct: 'https' | 'http' | 'unsupported';
  codecs?: string;
}

function directKind(url: string): RelayCheck['direct'] {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return 'https';
    if (parsed.protocol === 'http:') return 'http';
    return 'unsupported';
  } catch {
    return 'unsupported';
  }
}

async function checkRelayLine(line: LineEntry): Promise<RelayCheck> {
  const direct = directKind(line.url);
  try {
    const parsed = new URL(line.url);
    if (!/^https?:$/.test(parsed.protocol) || isPrivateHost(parsed.hostname)) {
      return { key: line.key, ok: false, status: 0, reason: '地址不可中继', direct };
    }
    const headers: Record<string, string> = { range: 'bytes=0-65535' };
    if (line.headers?.userAgent) headers['user-agent'] = line.headers.userAgent;
    if (line.headers?.referer) headers.referer = line.headers.referer;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(parsed.toString(), { headers, signal: controller.signal, redirect: 'follow' }).finally(() =>
      clearTimeout(timer),
    );
    if (!response.ok) return { key: line.key, ok: false, status: response.status, reason: `HTTP ${response.status}`, direct };
    const type = response.headers.get('content-type') ?? '';
    if (/mpegurl/i.test(type) || /\.m3u8$/i.test(parsed.pathname)) {
      const text = await response.text();
      const valid = /^\s*#EXTM3U/i.test(text) && /#EXTINF|#EXT-X-STREAM-INF/i.test(text);
      const codecs = /CODECS="([^"]+)"/i.exec(text)?.[1];
      return { key: line.key, ok: valid, status: response.status, reason: valid ? undefined : '不是有效的 HLS 清单', direct, codecs };
    }
    return { key: line.key, ok: true, status: response.status, direct };
  } catch (error) {
    return { key: line.key, ok: false, status: 0, reason: error instanceof Error && error.name === 'AbortError' ? '超时' : '不可达', direct };
  }
}

publicRoutes.get('/channels/:id', async (c) => {
  const id = c.req.param('id');
  const settings = await loadSettings(c.env);
  const shard = await loadChannelShard(c.env, id);
  if (shard) {
    // Never expose the real line URL or request headers to the public browser:
    // preview goes through /relay/line/<key>, admin APIs keep the full record.
    const [sources, pool] = await Promise.all([listSources(c.env), loadPoolSnapshot(c.env)]);
    const meta = sourceMetaMap(sources);
    const poolByKey = new Map<string, string>();
    for (const entry of Object.values(pool?.channels ?? {})) {
      for (const line of entry.premium) poolByKey.set(line.key, 'premium');
      for (const line of entry.backup) poolByKey.set(line.key, 'backup');
      for (const line of entry.candidate) poolByKey.set(line.key, 'candidate');
    }
    const safeLines = shard.lines.map(({ url, headers: _headers, ...rest }) => ({
      ...rest,
      speedKbps: Math.min(rest.speedKbps ?? 0, 50_000),
      resolution: rest.resolution ?? inferResolution(`${rest.name} ${url}`),
      sourceName: meta.get(rest.sourceId)?.name ?? rest.sourceId,
      sourceSite: meta.get(rest.sourceId)?.site ?? '未知来源',
      pool: poolByKey.get(rest.key) ?? null,
    }));
    return ok(
      {
        channel: shard.channel,
        lines: safeLines,
        epg: shard.epg ?? null,
        features: { relay: settings.relayEnabled, directPlayback: settings.directPlayback, frontLineLimit: settings.frontLineLimit ?? 0 },
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
      features: { relay: settings.relayEnabled, directPlayback: settings.directPlayback },
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
