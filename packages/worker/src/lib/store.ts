import type { Context } from 'hono';
import type { AppEnv, Env } from '../env.js';
import { fail } from './http.js';
import { isoNow } from './http.js';

export interface ArtifactMeta {
  contentType: string;
  etag: string;
  size: number;
  updatedAt: string;
  runId?: string;
}

const MAX_VALUE_BYTES = 24 * 1024 * 1024; // KV hard limit is 25 MiB

export interface ArtifactOptions {
  contentType?: string;
  maxAge?: number;
  sMaxAge?: number;
  filename?: string;
  cache?: boolean;
  contentEncoding?: string;
  vary?: string;
}

function bytesOf(body: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return body;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Write an artifact into Workers KV with an ETag + content type. */
export async function putArtifact(
  env: Env,
  key: string,
  body: string | Uint8Array | ArrayBuffer,
  contentType = 'application/octet-stream',
): Promise<ArtifactMeta> {
  const bytes = bytesOf(body);
  if (bytes.byteLength > MAX_VALUE_BYTES) {
    throw new Error(`产物 ${key} 超过 KV 单值 24MB 限制（${Math.round(bytes.byteLength / 1024 / 1024)}MB）`);
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const etag = `"${hex(digest).slice(0, 32)}"`;
  const meta: ArtifactMeta = { contentType, etag, size: bytes.byteLength, updatedAt: isoNow() };
  // KV writes are the scarce resource on the free plan. Skip rewriting a value
  // when the bytes and content type are unchanged.
  //
  // Read the metadata instead of listing the key: list operations have a much
  // smaller free quota (1k/day) than reads (100k/day), and a publish uploads
  // dozens of artifacts. The value stream is cancelled immediately — only the
  // metadata is needed.
  const existing = await env.KV.getWithMetadata<ArtifactMeta>(key, { type: 'stream' });
  if (existing.value) await existing.value.cancel().catch(() => undefined);
  const current = existing.metadata ?? undefined;
  if (current?.etag === etag && current.contentType === contentType) return current;
  await env.KV.put(key, bytes, { metadata: meta });
  return meta;
}

export async function getText(env: Env, key: string): Promise<string | null> {
  return env.KV.get(key, 'text');
}

/** Convenience wrapper used by the source-upload endpoint. */
export async function putText(
  env: Env,
  key: string,
  body: string,
  contentType = 'text/plain; charset=utf-8',
): Promise<void> {
  await putArtifact(env, key, body, contentType);
}

export async function getJson<T>(env: Env, key: string): Promise<T | null> {
  return env.KV.get<T>(key, 'json');
}

export async function exists(env: Env, key: string): Promise<boolean> {
  const value = await env.KV.get(key);
  return value !== null;
}

/**
 * Serve a KV artifact with ETag + edge caching.
 * Returns `null` when the key does not exist so callers can fall back.
 */
export async function serveArtifact(
  c: Context<AppEnv>,
  key: string,
  options: ArtifactOptions = {},
): Promise<Response | null> {
  const request = c.req.raw;
  const maxAge = options.maxAge ?? 60;
  const sMaxAge = options.sMaxAge ?? 300;
  const cache = options.cache === false ? null : cacheApi();

  if (cache) {
    const hit = await cache.match(request);
    if (hit) return hit;
  }

  const result = await c.env.KV.getWithMetadata<ArtifactMeta>(key, { type: 'stream', cacheTtl: 60 });
  if (!result.value) return null;

  const meta = result.metadata;
  const etag = meta?.etag ?? `W/"${key}"`;
  const cacheControl = `public, max-age=${maxAge}, s-maxage=${sMaxAge}`;
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag, 'cache-control': cacheControl } });
  }

  const headers = new Headers();
  headers.set('content-type', options.contentType ?? meta?.contentType ?? 'application/octet-stream');
  headers.set('etag', etag);
  headers.set('cache-control', cacheControl);
  if (meta?.updatedAt) headers.set('last-modified', new Date(meta.updatedAt).toUTCString());
  if (options.filename) headers.set('content-disposition', `inline; filename="${options.filename}"`);
  if (options.contentEncoding) headers.set('content-encoding', options.contentEncoding);
  if (options.vary) headers.set('vary', options.vary);

  const response = new Response(result.value, { headers });
  if (cache) c.executionCtx.waitUntil(cache.put(request, response.clone()).catch(() => undefined));
  return response;
}

/** `serveArtifact` + a standard 404 body. */
export async function serveArtifactOr404(
  c: Context<AppEnv>,
  key: string,
  options: ArtifactOptions = {},
): Promise<Response> {
  const response = await serveArtifact(c, key, options);
  return response ?? fail('资源尚未生成，请先完成一次采集任务', 404, 'not_ready');
}

function cacheApi(): Cache | null {
  try {
    return typeof caches !== 'undefined' ? caches.default : null;
  } catch {
    return null;
  }
}

export async function listArtifacts(env: Env, prefix: string, limit = 100): Promise<Array<{ key: string; size: number; uploaded: string }>> {
  const listing = await env.KV.list({ prefix, limit });
  return listing.keys.map((key) => ({
    key: key.name,
    size: Number((key.metadata as ArtifactMeta | null)?.size ?? 0),
    uploaded: String((key.metadata as ArtifactMeta | null)?.updatedAt ?? ''),
  }));
}

export async function deletePrefix(env: Env, prefix: string): Promise<number> {
  let cursor: string | undefined;
  let deleted = 0;
  for (let page = 0; page < 20; page++) {
    const listing = await env.KV.list({ prefix, cursor, limit: 1000 });
    if (!listing.keys.length) break;
    await Promise.all(listing.keys.map((key) => env.KV.delete(key.name)));
    deleted += listing.keys.length;
    if (listing.list_complete) break;
    cursor = listing.cursor;
  }
  return deleted;
}

/** Cache an already-built response (generated playlists, public JSON). */
export async function cacheResponse(c: Context<AppEnv>, response: Response, ttlSeconds: number): Promise<Response> {
  const cache = cacheApi();
  if (!cache || !response.ok) return response;
  response.headers.set('cache-control', `public, max-age=30, s-maxage=${ttlSeconds}`);
  const clone = response.clone();
  c.executionCtx.waitUntil(cache.put(new Request(c.req.url), clone).catch(() => undefined));
  return response;
}
