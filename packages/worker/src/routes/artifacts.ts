import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { getSubscriptionByToken } from '../db.js';
import { fail } from '../lib/http.js';
import { extensionFor, contentTypeFor, hashId, type PlaylistFormat } from '@iptv/core';
import { renderSubscription, subscriptionFromRow } from '../lib/playlist.js';
import { serveArtifact, serveArtifactOr404, cacheResponse, putArtifact } from '../lib/store.js';

export const artifactRoutes = new Hono<AppEnv>();

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
  const parsed = parseFile(c.req.param('file'));
  if (!parsed) return fail('订阅地址格式不正确', 404);

  const row = await getSubscriptionByToken(c.env, parsed.token);
  if (!row || row.enabled !== 1) return fail('订阅不存在或已停用', 404);

  const config = subscriptionFromRow(row);
  const queryFormat = c.req.query('format');
  if (queryFormat && ['m3u', 'txt', 'json', 'diyp'].includes(queryFormat)) {
    config.format = queryFormat as PlaylistFormat;
  } else if (parsed.format) {
    config.format = parsed.format;
  }

  // Fast path: the runner pre-renders every subscription (zero CPU here).
  const prebuilt = config.format === 'diyp'
    ? `out/sub-${config.id}.diyp`
    : `out/sub-${config.id}.${extensionFor(config.format)}`;
  const prebuiltResponse = await serveArtifact(c, prebuilt, {
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
  // KV read instead of a full catalog parse.
  c.executionCtx.waitUntil(
    putArtifact(c.env, prebuilt, rendered.body, contentTypeFor(config.format)).catch(() => undefined),
  );

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
  const row = await getSubscriptionByToken(c.env, match[1]!);
  if (!row || row.enabled !== 1) return fail('订阅不存在或已停用', 404);

  // Prefer the per-subscription guide (much smaller for players).
  const perSub = await serveArtifact(c, `out/epg-${row.id}.xml`, {
    contentType: 'application/xml; charset=utf-8',
    filename: `${encodeURIComponent(row.name)}.xml`,
    maxAge: 300,
    sMaxAge: 900,
  });
  if (perSub) return perSub;

  return serveArtifactOr404(c, 'out/epg.xml', {
    contentType: 'application/xml; charset=utf-8',
    filename: 'epg.xml',
    maxAge: 300,
    sMaxAge: 900,
  });
});
