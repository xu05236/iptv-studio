import { Hono } from 'hono';
import type { Context } from 'hono';
import { DEFAULT_UA, isPrivateHost, type LineEntry, type RequestHeaders } from '@iptv/core';
import type { AppEnv, Env } from '../env.js';
import { getSubscriptionByToken, loadSettings } from '../db.js';
import { fail } from '../lib/http.js';
import { loadCatalog } from '../lib/catalog.js';
import { loadLineIndex } from '../lib/lineIndex.js';

export const relayRoutes = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

const encoder = new TextEncoder();
const TTL_SECONDS = 600;

// F6: settings 在 Worker 内存里缓存 60 秒，避免每个分片请求都打一次 D1。
let settingsCache: { at: number; value: Awaited<ReturnType<typeof loadSettings>> } | null = null;
async function relaySettings(env: Env): Promise<Awaited<ReturnType<typeof loadSettings>>> {
  if (settingsCache && Date.now() - settingsCache.at < 60_000) return settingsCache.value;
  const value = await loadSettings(env);
  settingsCache = { at: Date.now(), value };
  return value;
}

// F6: 按 token/key 的粗粒度配额（按 isolate 计数；免费版不写 D1/KV，避免反而吃额度）。
const QUOTA_REQUESTS_PER_DAY = 20_000;
const QUOTA_BYTES_PER_DAY = 2 * 1024 ** 3;
const quotas = new Map<string, { day: string; requests: number; bytes: number }>();
function overQuota(id: string, bytes = 0): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const item = quotas.get(id) ?? { day, requests: 0, bytes: 0 };
  if (item.day !== day) {
    item.day = day;
    item.requests = 0;
    item.bytes = 0;
  }
  item.requests++;
  item.bytes += bytes;
  quotas.set(id, item);
  if (quotas.size > 5_000) quotas.clear();
  return item.requests > QUOTA_REQUESTS_PER_DAY || item.bytes > QUOTA_BYTES_PER_DAY;
}

/** 旧中继只放行播放清单，防止带任何订阅 token 就能代理任意 URL。 */
function isPlaylistUrl(target: URL): boolean {
  return /\.(m3u8?|mpd)$/i.test(target.pathname);
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return base64Url(new Uint8Array(signature));
}

function secretOf(env: Env): string {
  return env.SESSION_SECRET || env.ADMIN_TOKEN || 'iptv-studio-relay';
}

async function verifySignature(env: Env, key: string, target: string, expires: number, signature: string): Promise<boolean> {
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;
  return (await hmac(secretOf(env), `${key}|${target}|${expires}`)) === signature;
}

function isPlaylist(response: Response, target: URL): boolean {
  return /mpegurl/i.test(response.headers.get('content-type') ?? '') || /\.m3u8?(\?|$)/i.test(target.pathname);
}

async function fetchUpstream(c: Ctx, target: URL, headersIn: RequestHeaders): Promise<Response> {
  const headers = new Headers({ 'User-Agent': headersIn.userAgent || DEFAULT_UA, Accept: '*/*' });
  if (headersIn.referer) headers.set('Referer', headersIn.referer);
  if (headersIn.origin) headers.set('Origin', headersIn.origin);
  if (headersIn.cookie) headers.set('Cookie', headersIn.cookie);
  const range = c.req.header('range');
  if (range) headers.set('Range', range);
  return fetch(target.toString(), { headers, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
}

function playlistResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}

function streamResponse(upstream: Response): Response {
  const headers = new Headers();
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('access-control-allow-origin', '*');
  headers.set('cache-control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, headers });
}

async function rewritePlaylist(text: string, base: string, proxy: (absolute: string) => Promise<string>): Promise<string> {
  const resolve = (value: string): string => {
    try {
      return new URL(value, base).toString();
    } catch {
      return value;
    }
  };

  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }
    if (trimmed.startsWith('#')) {
      if (/^#EXT-X-(KEY|MAP|MEDIA)/i.test(trimmed) && /URI="/i.test(trimmed)) {
        const match = /URI="([^"]+)"/i.exec(trimmed);
        if (match?.[1]) {
          out.push(trimmed.replace(/URI="[^"]+"/i, `URI="${await proxy(resolve(match[1]))}"`));
          continue;
        }
      }
      out.push(line);
      continue;
    }
    out.push(await proxy(resolve(trimmed)));
  }
  return out.join('\n');
}

function lineUrl(c: Ctx, key: string, absolute: string): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  return hmac(secretOf(c.env), `${key}|${absolute}|${expires}`).then((signature) => {
    const url = new URL(`${new URL(c.req.url).origin}/relay/line/${encodeURIComponent(key)}`);
    url.searchParams.set('u', absolute);
    url.searchParams.set('exp', String(expires));
    url.searchParams.set('sig', signature);
    return url.toString();
  });
}

function subscriptionUrl(c: Ctx, token: string, absolute: string): string {
  const url = new URL(`${new URL(c.req.url).origin}/relay`);
  url.searchParams.set('u', absolute);
  url.searchParams.set('token', token);
  return url.toString();
}

/**
 * Legacy subscription-scoped relay: accepts an arbitrary upstream URL, but only
 * with a valid subscription token.
 */
relayRoutes.get('/', async (c) => {
  const settings = await relaySettings(c.env);
  if (!settings.relayEnabled) return fail('中继功能未开启（设置 → 高级）', 403);

  const token = c.req.query('token') ?? '';
  const subscription = await getSubscriptionByToken(c.env, token);
  if (!subscription || subscription.enabled !== 1) return fail('订阅令牌无效', 401);
  if (overQuota(`token:${token}`)) return fail('中继配额已用完', 429, 'relay_quota');

  const raw = c.req.query('u');
  if (!raw) return fail('缺少 u 参数');
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return fail('地址不合法');
  }
  if (!/^https?:$/.test(target.protocol) || isPrivateHost(target.hostname)) return fail('地址不合法');
  if (!isPlaylistUrl(target)) return fail('旧中继只允许播放清单（.m3u8/.m3u/.mpd）', 403, 'relay_url_blocked');

  const upstream = await fetchUpstream(c, target, { userAgent: DEFAULT_UA }).catch(() => null);
  if (!upstream) return fail('上游线路超时或不可达', 504);
  if (isPlaylist(upstream, target)) {
    const text = await upstream.text();
    const base = upstream.url || target.toString();
    return playlistResponse(await rewritePlaylist(text, base, async (url) => subscriptionUrl(c, token, url)), upstream.status);
  }
  return streamResponse(upstream);
});

/**
 * Line-scoped relay used by the public player. The key must exist in the
 * published catalog, so it cannot become an open proxy; segment URLs are
 * short-lived HMAC signatures bound to that key.
 */
relayRoutes.get('/line/:key', async (c) => {
  const settings = await relaySettings(c.env);
  if (!settings.relayEnabled) return fail('中继功能未开启（设置 → 高级）', 403);

  const key = c.req.param('key');
  if (overQuota(`key:${key}`)) return fail('中继配额已用完', 429, 'relay_quota');

  // F6: 热路径只查紧凑索引（内存 60s / Cache API / 单值 KV），不再解析整份 probe.json。
  const index = await loadLineIndex(c.env);
  const indexed = index.get(key);
  let sourceUrl = indexed?.url;
  let sourceHeaders = indexed?.headers;

  if (!sourceUrl) {
    const catalog = await loadCatalog(c.env);
    for (const item of catalog?.items ?? []) {
      const candidate = item.lines.find((line) => line.key === key);
      if (candidate) {
        sourceUrl = candidate.url;
        sourceHeaders = candidate.headers;
        break;
      }
    }
  }
  if (!sourceUrl) return fail('线路不存在', 404);

  let target = sourceUrl;
  const signed = c.req.query('u');
  if (signed) {
    const expires = Number(c.req.query('exp') ?? '0');
    const signature = c.req.query('sig') ?? '';
    if (!(await verifySignature(c.env, key, signed, expires, signature))) return fail('中继签名无效或已过期', 403);
    target = signed;
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return fail('地址不合法');
  }
  if (!/^https?:$/.test(parsed.protocol) || isPrivateHost(parsed.hostname)) return fail('地址不合法');

  const upstream = await fetchUpstream(c, parsed, sourceHeaders ?? { userAgent: DEFAULT_UA }).catch(() => null);
  if (!upstream) return fail('上游线路超时或不可达', 504);
  if (upstream.status >= 400) {
    const detail = await upstream.text().catch(() => '');
    const cloudflareCode = /error\s*code[:\s]*(\d+)/i.exec(detail)?.[1];
    return fail(`上游线路返回 HTTP ${upstream.status}${cloudflareCode ? `（Cloudflare ${cloudflareCode}）` : ''}`, 502);
  }
  if (isPlaylist(upstream, parsed)) {
    const text = await upstream.text();
    const base = upstream.url || parsed.toString();
    return playlistResponse(await rewritePlaylist(text, base, (url) => lineUrl(c, key, url)), upstream.status);
  }
  return streamResponse(upstream);
});
