import { fetchText } from '@iptv/core';

export interface FetchTextOptions {
  etag?: string | null;
  lastModified?: string | null;
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  retries?: number;
}

export interface FetchTextResult {
  ok: boolean;
  status: number;
  text?: string;
  encoding?: string;
  etag?: string | null;
  lastModified?: string | null;
  notModified?: boolean;
  error?: string;
}

/**
 * 抓取订阅/播放列表。Worker 侧统一走 `@iptv/core` 的 `fetchText`（20 秒超时、
 * 条件请求、24MB 截断、仅对瞬时错误重试），这里只保留一层给路由用的薄封装。
 */
export async function fetchSourceText(url: string, options: FetchTextOptions = {}): Promise<FetchTextResult> {
  const result = await fetchText(url, { ...options, timeoutMs: options.timeoutMs ?? 20_000 });
  return {
    ok: result.ok,
    status: result.status,
    text: result.text,
    encoding: result.encoding,
    etag: result.etag,
    lastModified: result.lastModified,
    notModified: result.notModified,
    error: result.error,
  };
}
