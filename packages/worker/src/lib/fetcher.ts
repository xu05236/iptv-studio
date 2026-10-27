import { readTextCapped } from '@iptv/core';

export interface FetchTextOptions {
  etag?: string | null;
  lastModified?: string | null;
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
}

export interface FetchTextResult {
  ok: boolean;
  status: number;
  text?: string;
  etag?: string | null;
  lastModified?: string | null;
  notModified?: boolean;
  error?: string;
}

/** Fetch a playlist with conditional headers (ETag / Last-Modified). */
export async function fetchSourceText(url: string, options: FetchTextOptions = {}): Promise<FetchTextResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs ?? 20_000);
  const headers: Record<string, string> = {
    'User-Agent': 'IPTV-Studio/0.1 (+https://github.com/)',
    Accept: 'application/json, text/plain, application/x-mpegURL, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
    ...options.headers,
  };
  if (options.etag) headers['If-None-Match'] = options.etag;
  if (options.lastModified) headers['If-Modified-Since'] = options.lastModified;

  try {
    const response = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
    if (response.status === 304) {
      return { ok: true, status: 304, notModified: true, etag: options.etag, lastModified: options.lastModified };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, error: `HTTP ${response.status}` };
    }
    const text = await readTextCapped(response.body, options.maxBytes ?? 24 * 1024 * 1024);
    return {
      ok: true,
      status: response.status,
      text,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: controller.signal.aborted ? '请求超时' : error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
