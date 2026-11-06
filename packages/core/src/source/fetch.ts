import { readTextCapped } from '../probe/measure.js';

export type FetchErrorKind = 'timeout' | 'network' | 'http';

export interface FetchTextOptions {
  /** Conditional request: previous ETag. */
  etag?: string | null;
  /** Conditional request: previous Last-Modified. */
  lastModified?: string | null;
  timeoutMs?: number;
  maxBytes?: number;
  /** Extra request headers; they override the defaults (source-level UA/Referer/Cookie). */
  headers?: Record<string, string>;
  /** Default UA when `headers` does not set one. */
  userAgent?: string;
  /** Number of retries after the first attempt (default 0). */
  retries?: number;
  retryDelayMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface FetchTextResult {
  ok: boolean;
  status: number;
  text?: string;
  etag?: string | null;
  lastModified?: string | null;
  notModified?: boolean;
  error?: string;
  errorKind?: FetchErrorKind;
  attempts: number;
}

export interface SourceHeadersResult {
  ok: boolean;
  headers: Record<string, string>;
  error?: string;
}

const FORBIDDEN_SOURCE_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade']);

/**
 * 校验后台填写的「源级请求头」：对象或 JSON 字符串；只允许普通请求头，
 * 单值 ≤2KB，最多 16 个，禁止 Host/Content-Length 等会破坏请求的字段。
 */
export function sanitizeSourceHeaders(input: unknown): SourceHeadersResult {
  let value = input;
  if (value === undefined || value === null || value === '') return { ok: true, headers: {} };
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false, headers: {}, error: '请求设置必须是 JSON 对象' };
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, headers: {}, error: '请求设置必须是 JSON 对象' };
  const headers: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!/^[A-Za-z0-9-]{1,64}$/.test(key)) return { ok: false, headers: {}, error: `请求头名称不合法：${rawKey}` };
    if (FORBIDDEN_SOURCE_HEADERS.has(key.toLowerCase())) return { ok: false, headers: {}, error: `不允许设置请求头 ${key}` };
    if (typeof rawValue !== 'string' || /[\r\n]/.test(rawValue)) return { ok: false, headers: {}, error: `请求头 ${key} 的值必须是单行字符串` };
    if (rawValue.length > 2048) return { ok: false, headers: {}, error: `请求头 ${key} 的值超过 2KB` };
    if (Object.keys(headers).length >= 16) return { ok: false, headers: {}, error: '请求头最多 16 个' };
    headers[key] = rawValue;
  }
  return { ok: true, headers };
}

export const DEFAULT_SOURCE_UA = 'IPTV-Studio/0.1 (+https://github.com/xu05236/iptv-studio)';
export const DEFAULT_SOURCE_ACCEPT = 'application/json, text/plain, application/x-mpegURL, */*';
export const DEFAULT_MAX_BYTES = 24 * 1024 * 1024;

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Only transient failures deserve another attempt; 4xx means the request itself is wrong. */
export function isRetryable(result: Pick<FetchTextResult, 'ok' | 'status' | 'errorKind'>): boolean {
  if (result.ok) return false;
  if (result.errorKind === 'timeout' || result.errorKind === 'network') return true;
  return result.errorKind === 'http' && RETRYABLE_STATUS.has(result.status);
}

function mergeHeaders(options: FetchTextOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': options.userAgent ?? DEFAULT_SOURCE_UA,
    Accept: DEFAULT_SOURCE_ACCEPT,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
  };
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value) headers[key] = value;
  }
  if (options.etag && !Object.keys(options.headers ?? {}).some((key) => key.toLowerCase() === 'if-none-match')) {
    headers['If-None-Match'] = options.etag;
  }
  if (options.lastModified && !Object.keys(options.headers ?? {}).some((key) => key.toLowerCase() === 'if-modified-since')) {
    headers['If-Modified-Since'] = options.lastModified;
  }
  return headers;
}

/**
 * Single shared fetch implementation for playlists/subscription files.
 *
 * - conditional requests via ETag / Last-Modified (304 returns `notModified`)
 * - hard timeout with a tombstoned abort reason
 * - 24MB body cap (`readTextCapped` truncates, it never throws)
 * - retries only for timeout / network / 408 / 429 / 5xx
 *
 * Uses only Web APIs so the Worker and the runner can both import it.
 */
export async function fetchText(url: string, options: FetchTextOptions = {}): Promise<FetchTextResult> {
  const maxAttempts = 1 + Math.max(0, Number(options.retries) || 0);
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs) || 1_000);
  const fetchImpl = options.fetchImpl ?? fetch;
  let last: FetchTextResult = { ok: false, status: 0, attempts: 0 };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs ?? 20_000);
    try {
      const response = await fetchImpl(url, { headers: mergeHeaders(options), redirect: 'follow', signal: controller.signal });
      if (response.status === 304) {
        return { ok: true, status: 304, notModified: true, etag: options.etag ?? null, lastModified: options.lastModified ?? null, attempts: attempt };
      }
      if (!response.ok) {
        last = { ok: false, status: response.status, error: `HTTP ${response.status}`, errorKind: 'http', attempts: attempt };
      } else {
        const text = await readTextCapped(response.body, options.maxBytes ?? DEFAULT_MAX_BYTES);
        return {
          ok: true,
          status: response.status,
          text,
          etag: response.headers.get('etag'),
          lastModified: response.headers.get('last-modified'),
          attempts: attempt,
        };
      }
    } catch (error) {
      const message = timedOut ? '请求超时' : error instanceof Error ? error.message : String(error);
      last = { ok: false, status: 0, error: message, errorKind: timedOut ? 'timeout' : 'network', attempts: attempt };
    } finally {
      clearTimeout(timer);
    }
    if (attempt >= maxAttempts || !isRetryable(last)) break;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
  }
  return last;
}
