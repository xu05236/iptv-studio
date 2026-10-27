import { Hono } from 'hono';
import { DEFAULT_UA, isPrivateHost } from '@iptv/core';
import type { AppEnv } from '../env.js';
import { getSubscriptionByToken, loadSettings } from '../db.js';
import { fail } from '../lib/http.js';

export const relayRoutes = new Hono<AppEnv>();

/**
 * Optional HLS relay: rewrites playlists so segments also travel through the
 * Worker. Many IPTV origins send no CORS headers, which makes browser preview
 * impossible without it. Disabled by default — proxying video through Workers
 * is a Cloudflare ToS grey area, enable it knowingly (see docs/DEPLOY.md).
 */
relayRoutes.get('/', async (c) => {
  const settings = await loadSettings(c.env);
  if (!settings.relayEnabled) return fail('中继功能未开启（设置 → 高级）', 403);

  const token = c.req.query('token') ?? '';
  const subscription = await getSubscriptionByToken(c.env, token);
  if (!subscription || subscription.enabled !== 1) return fail('订阅令牌无效', 401);

  const raw = c.req.query('u');
  if (!raw) return fail('缺少 u 参数');
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return fail('地址不合法');
  }
  if (!/^https?:$/.test(target.protocol) || isPrivateHost(target.hostname)) return fail('地址不合法');

  const ua = (c.req.query('ua') ?? DEFAULT_UA).slice(0, 300);
  const ref = c.req.query('ref');
  const headers = new Headers({ 'User-Agent': ua, Accept: '*/*' });
  if (ref) headers.set('Referer', ref.slice(0, 500));
  const range = c.req.header('range');
  if (range) headers.set('Range', range);

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), { headers, redirect: 'follow' });
  } catch (error) {
    return fail(`上游请求失败: ${error instanceof Error ? error.message : String(error)}`, 502);
  }

  const contentType = upstream.headers.get('content-type') ?? '';
  if (/mpegurl/i.test(contentType) || /\.m3u8?(\?|$)/i.test(target.pathname)) {
    const text = await upstream.text();
    const base = upstream.url || target.toString();
    const body = rewritePlaylist(text, base, c.req.url, token, ua, ref);
    return new Response(body, {
      status: upstream.status,
      headers: {
        'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      },
    });
  }

  const out = new Headers();
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  out.set('access-control-allow-origin', '*');
  out.set('cache-control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, headers: out });
});

function rewritePlaylist(text: string, base: string, requestUrl: string, token: string, ua: string, ref?: string): string {
  const origin = new URL(requestUrl).origin;
  const proxy = (absolute: string): string => {
    const url = new URL(`${origin}/relay`);
    url.searchParams.set('u', absolute);
    url.searchParams.set('token', token);
    if (ua) url.searchParams.set('ua', ua);
    if (ref) url.searchParams.set('ref', ref);
    return url.toString();
  };

  const resolve = (value: string): string => {
    try {
      return new URL(value, base).toString();
    } catch {
      return value;
    }
  };

  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        if (/^#EXT-X-(KEY|MAP|MEDIA)/i.test(trimmed) && /URI="/i.test(trimmed)) {
          return trimmed.replace(/URI="([^"]+)"/i, (_match, uri: string) => `URI="${proxy(resolve(uri))}"`);
        }
        return line;
      }
      return proxy(resolve(trimmed));
    })
    .join('\n');
}
