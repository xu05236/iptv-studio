import type { Protocol, RequestHeaders } from '../types.js';
import { guessProtocol } from '../util/url.js';

export interface LivenessResult {
  ok: boolean;
  status?: number;
  protocol: Protocol;
  latencyMs: number;
  error?: string;
  /** Protocol cannot be checked from an HTTP runtime (rtsp/rtmp/udp). */
  inconclusive?: boolean;
}

export interface LivenessOptions {
  headers?: RequestHeaders;
  timeoutMs?: number;
}

async function readPrefix(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  let received = 0;
  const chunks: Uint8Array[] = [];
  while (received < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const take = value.subarray(0, Math.max(0, limit - received));
    chunks.push(take);
    received += take.byteLength;
    if (take.byteLength < value.byteLength) break;
  }
  await reader.cancel().catch(() => undefined);
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Cheap liveness check for lines already in the pool: HLS only needs a valid
 * manifest, direct streams only need a small range response. No speed sampling
 * and no resolution probing, so a whole pool round costs a fraction of a full
 * probe.
 */
export async function probeLiveness(url: string, options: LivenessOptions = {}): Promise<LivenessResult> {
  const protocol = guessProtocol(url);
  const started = Date.now();
  if (protocol !== 'hls' && protocol !== 'http') {
    return { ok: true, protocol, latencyMs: 0, inconclusive: true, error: '无法在 HTTP 环境中探测' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  const headers: Record<string, string> = {};
  if (options.headers?.userAgent) headers['user-agent'] = options.headers.userAgent;
  if (options.headers?.referer) headers.referer = options.headers.referer;
  if (options.headers?.origin) headers.origin = options.headers.origin;
  if (options.headers?.cookie) headers.cookie = options.headers.cookie;

  try {
    if (protocol === 'hls') {
      const response = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
      const latencyMs = Date.now() - started;
      if (!response.ok) return { ok: false, status: response.status, protocol, latencyMs, error: `HTTP ${response.status}` };
      const prefix = await readPrefix(response, 4 * 1024);
      if (!prefix.includes('#EXTM3U')) {
        return { ok: false, status: response.status, protocol, latencyMs, error: '不是有效的 HLS 清单' };
      }
      return { ok: true, status: response.status, protocol, latencyMs };
    }

    const response = await fetch(url, {
      headers: { ...headers, range: 'bytes=0-2047' },
      signal: controller.signal,
      redirect: 'follow',
    });
    const latencyMs = Date.now() - started;
    if (!response.ok && response.status !== 206) {
      return { ok: false, status: response.status, protocol, latencyMs, error: `HTTP ${response.status}` };
    }
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength) return { ok: false, status: response.status, protocol, latencyMs, error: '响应为空' };
    return { ok: true, status: response.status, protocol, latencyMs };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const aborted = error instanceof Error && error.name === 'AbortError';
    return { ok: false, protocol, latencyMs: Date.now() - started, error: aborted ? '超时' : message };
  } finally {
    clearTimeout(timer);
  }
}
