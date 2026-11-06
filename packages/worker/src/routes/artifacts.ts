import { Hono } from 'hono';
import type { AppEnv, Env } from '../env.js';
import { getSubscriptionByToken, resolveSubscriptionByToken, touchSubscriptionToken } from '../db.js';
import { fail } from '../lib/http.js';
import { getRuntimeJson } from '../lib/runtime-state.js';
import { extensionFor, contentTypeFor, hashId, type PlaylistFormat } from '@iptv/core';
import { renderSubscription, subscriptionFromRow } from '../lib/playlist.js';
import { serveArtifact, serveArtifactOr404, cacheResponse, putArtifact } from '../lib/store.js';

export const artifactRoutes = new Hono<AppEnv>();

/**
 * Self-heal write-through is only a cache warm-up, never a correctness
 * requirement. On the KV free tier (1k writes/day) a popular subscription
 * would otherwise rewrite the same key on every request. Keep one write per
 * key per minute and stop writing once the daily quota is nearly spent.
 */
const SELF_HEAL_COOLDOWN_MS = 60_000;
const selfHealAt = new Map<string, number>();
let quotaCache: { at: number; writes: number } | null = null;

async function kvWritesToday(env: Env): Promise<number> {
  const now = Date.now();
  if (quotaCache && now - quotaCache.at < 60_000) return quotaCache.writes;
  const usage = await getRuntimeJson<{ kv?: { day?: string; writes?: number } }>(env, 'state/usage.json');
  const today = new Date().toISOString().slice(0, 10);
  const writes = usage?.kv?.day === today ? Number(usage.kv.writes ?? 0) : 0;
  quotaCache = { at: now, writes };
  return writes;
}

function baseUrl(c: { req: { url: string }; env: { PUBLIC_BASE_URL?: string } }): string {
  return (c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin).replace(/\/+$/, '');
}

function parseFile(file: string): { token: string; format?: PlaylistFormat } | null {
  const match = /^([a-z0-9]{8,64})(?:\.(m3u|txt|json|diyp))?$/i.exec(file);
  if (!match) return null;
  return { token: match[1]!, format: match[2] as PlaylistFormat | undefined };
}

/**
 * Subscription endpoint: `/sub/<token>.m3u`. Rendered on demand from the
 * published catalog (so a brand new subscription works immediately) with a
 * strong ETag and edge caching.
 */
artifactRoutes.get('/sub/:file', async (c) => {
  const file = c.req.param('file');
  const tvbox = /^([a-z0-9]{8,64})\.tvbox$/i.exec(file);
  if (tvbox) {
    const resolved = await resolveSubscriptionByToken(c.env, tvbox[1]!);
    if (!resolved) return fail('订阅不存在或已停用', 404);
    const { row } = resolved;
    if (resolved.tokenRow) {
      try {
        c.executionCtx.waitUntil(touchSubscriptionToken(c.env, tvbox[1]!, Date.now()));
      } catch {
        /* 本地无 executionCtx 时跳过 last_seen 写 */
      }
    }
    const prebuilt = `out/sub-${row.id}.tvbox`;
    const response = await serveArtifact(c, prebuilt, {
      contentType: 'application/json; charset=utf-8',
      filename: `${encodeURIComponent(row.name)}.tvbox`,
      maxAge: 60,
      sMaxAge: 300,
    });
    if (response) return response;
    const url = `${baseUrl(c)}/sub/${row.token}.m3u`;
    const epg = row.include_epg === 1 ? `${baseUrl(c)}/epg/${row.token}.xml` : undefined;
    return new Response(JSON.stringify({ name: 'IPTV Studio', epg, lives: [{ name: row.name, type: 0, url, playerType: 1 }] }), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const parsed = parseFile(file);
  if (!parsed) return fail('订阅地址格式不正确', 404);

  const resolved = await resolveSubscriptionByToken(c.env, parsed.token);
  if (!resolved) return fail('订阅不存在或已停用', 404);
  const { row } = resolved;
  if (resolved.tokenRow) {
    try {
      c.executionCtx.waitUntil(touchSubscriptionToken(c.env, parsed.token, Date.now()));
    } catch {
      /* 本地无 executionCtx 时跳过 last_seen 写 */
    }
  }

  const config = subscriptionFromRow(row);
  const queryFormat = c.req.query('format');
  if (queryFormat && ['m3u', 'txt', 'json', 'diyp'].includes(queryFormat)) {
    config.format = queryFormat as PlaylistFormat;
  } else if (parsed.format) {
    config.format = parsed.format;
  }

  // Pool-driven subscriptions are rendered live so manual pool moves apply
  // immediately; a prebuilt file from an older run would shadow that.
  const poolDriven = !config.lineKeys?.length && (config.poolMode === 'premium' || config.poolMode === 'premium_backup');

  // Fast path: the runner pre-renders catalog subscriptions (zero CPU here).
  const prebuilt = config.format === 'diyp'
    ? `out/sub-${config.id}.diyp`
    : `out/sub-${config.id}.${extensionFor(config.format)}`;
  const prebuiltResponse = poolDriven || config.proxyMode !== 'direct' ? null : await serveArtifact(c, prebuilt, {
    contentType: contentTypeFor(config.format),
    filename: `${encodeURIComponent(config.name)}.${extensionFor(config.format)}`,
    maxAge: 60,
    sMaxAge: 300,
  });
  if (prebuiltResponse) return prebuiltResponse;

  const etag = `W/"${hashId(`${config.token}:${config.format}:${config.updatedAt ?? ''}`)}"`;
  const ifNoneMatch = c.req.header('if-none-match');
  const rendered = await renderSubscription(c.env, config, baseUrl(c));

  if (!rendered) {
    return fail('尚未生成频道数据，请先运行一次采集任务', 409, 'not_ready');
  }

  const finalEtag = rendered.etag || etag;
  if (ifNoneMatch && ifNoneMatch === finalEtag) {
    return new Response(null, { status: 304, headers: { etag: finalEtag, 'cache-control': 'public, max-age=60' } });
  }

  // Self-heal: persist the rendered playlist so the next request is a static
  // KV read instead of a full catalog parse. Pool subscriptions are skipped:
  // their content changes with overrides, so the snapshot must stay live.
  if (!poolDriven) {
    const now = Date.now();
    if (now - (selfHealAt.get(prebuilt) ?? 0) >= SELF_HEAL_COOLDOWN_MS) {
      selfHealAt.set(prebuilt, now);
      if (selfHealAt.size > 500) selfHealAt.clear();
      c.executionCtx.waitUntil(
        (async () => {
          if (await kvWritesToday(c.env) >= 900) return;
          await putArtifact(c.env, prebuilt, rendered.body, contentTypeFor(config.format));
        })().catch(() => undefined),
      );
    }
  }

  const response = new Response(rendered.body, {
    status: 200,
    headers: {
      'content-type': contentTypeFor(config.format),
      'content-disposition': `inline; filename="${encodeURIComponent(config.name)}.${extensionFor(config.format)}"`,
      etag: finalEtag,
      'cache-control': 'public, max-age=60, s-maxage=300',
      'x-iptv-channels': String(rendered.channels),
      'x-iptv-lines': String(rendered.lines),
      'access-control-allow-origin': '*',
    },
  });
  return cacheResponse(c, response, 300);
});

artifactRoutes.get('/shots/:file', async (c) => {
  const match = /^([a-z0-9-]{2,80})\.jpg$/i.exec(c.req.param('file'));
  if (!match) return fail('截图不存在', 404);
  return serveArtifactOr404(c, `shots/${match[1]}.jpg`, {
    contentType: 'image/jpeg',
    maxAge: 86_400,
    sMaxAge: 604_800,
  });
});

artifactRoutes.get('/epg/:file', async (c) => {
  const file = c.req.param('file');
  const match = /^([a-z0-9]{8,64})\.xml$/i.exec(file);
  if (!match) return fail('节目单地址格式不正确', 404);
  const resolved = await resolveSubscriptionByToken(c.env, match[1]!);
  if (!resolved) return fail('订阅不存在或已停用', 404);
  const { row } = resolved;
  if (resolved.tokenRow) {
    try {
      c.executionCtx.waitUntil(touchSubscriptionToken(c.env, match[1]!, Date.now()));
    } catch {
      /* 本地无 executionCtx 时跳过 last_seen 写 */
    }
  }

  // Serve the raw XML and let Cloudflare compress it at the edge. Returning a
  // pre-gzipped body with Content-Encoding: gzip double-compresses it: the
  // Workers runtime drops that header and the edge gzips the already-gzipped
  // bytes, so players that accept gzip received a gzip file inside gzip.
  // Without Vary the cached representation also leaked to identity clients.
  const perSub = await serveArtifact(c, `out/epg-${row.id}.xml`, {
    contentType: 'application/xml; charset=utf-8',
    filename: `${encodeURIComponent(row.name)}.xml`,
    maxAge: 300,
    sMaxAge: 900,
    vary: 'Accept-Encoding',
  });
  if (perSub) return perSub;

  return serveArtifactOr404(c, 'out/epg.xml', {
    contentType: 'application/xml; charset=utf-8',
    filename: 'epg.xml',
    maxAge: 300,
    sMaxAge: 900,
    vary: 'Accept-Encoding',
  });
});
