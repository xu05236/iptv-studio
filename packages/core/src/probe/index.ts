import type { ProbeResult, RequestHeaders } from '../types.js';
import { guessProtocol, splitUrlHeaders } from '../util/url.js';
import { measureReader, now, qualityFromResolution, readTextCapped } from './measure.js';
import { probeHls } from './hls.js';

export const DEFAULT_UA = 'VLC/3.0.20 LibVLC/3.0.20';

export interface ProbeOptions {
  headers?: RequestHeaders;
  timeoutMs?: number;
  warmupBytes?: number;
  sampleMs?: number;
  maxBytes?: number;
  userAgent?: string;
  signal?: AbortSignal;
}

export function buildHeaders(headers: RequestHeaders = {}, userAgent = DEFAULT_UA): HeadersInit {
  const out: Record<string, string> = {
    'User-Agent': headers.userAgent || userAgent,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
    'Cache-Control': 'no-cache',
  };
  if (headers.referer) out.Referer = headers.referer;
  if (headers.origin) out.Origin = headers.origin;
  if (headers.cookie) out.Cookie = headers.cookie;
  return out;
}

/**
 * Probe any stream URL. HLS is decoded down to a real segment; other protocols
 * get a steady-state byte measurement. RTSP/RTMP/UDP cannot be validated from a
 * stateless HTTP runtime and are reported as unsupported instead of "dead".
 */
export async function probeStream(rawUrl: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const checkedAt = new Date().toISOString();
  const { url, headers: suffix } = splitUrlHeaders(rawUrl);
  if (!url) return { ok: false, protocol: 'unknown', error: '空地址', checkedAt };

  const protocol = guessProtocol(url);
  const headers = buildHeaders({ ...options.headers, ...suffix }, options.userAgent);
  const timeoutMs = options.timeoutMs ?? 9_000;

  if (protocol === 'rtsp' || protocol === 'rtmp' || protocol === 'udp' || protocol === 'rtp') {
    return {
      ok: false,
      protocol,
      error: `${protocol.toUpperCase()} 协议无法在 HTTP 环境中探测（需在本机用 ffprobe）`,
      checkedAt,
    };
  }
  if (protocol === 'unknown') return { ok: false, protocol, error: '不支持的地址格式', checkedAt };

  if (protocol === 'hls') {
    return probeHls(url, {
      headers,
      timeoutMs,
      warmupBytes: options.warmupBytes ?? 512 * 1024,
      sampleMs: options.sampleMs ?? 1_500,
      signal: options.signal,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const startedAt = now();

  try {
    const response = await fetch(url, {
      headers: { ...(headers as Record<string, string>), Range: `bytes=0-${(options.maxBytes ?? 4 * 1024 * 1024) - 1}` },
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, status: response.status, protocol: 'http', error: `HTTP ${response.status}`, checkedAt };
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (/mpegurl|x-mpegURL/i.test(contentType)) {
      return probeHls(url, {
        headers,
        timeoutMs,
        warmupBytes: options.warmupBytes ?? 512 * 1024,
        sampleMs: options.sampleMs ?? 1_500,
        signal: options.signal,
      });
    }

    const body = response.body;
    if (!body) {
      return { ok: false, status: response.status, protocol: 'http', contentType, error: '响应没有内容', checkedAt };
    }

    const reader = body.getReader();
    const first = await reader.read();
    const firstChunk = first.done ? undefined : first.value;
    const head = firstChunk ? new TextDecoder().decode(firstChunk.subarray(0, 64)) : '';
    if (head.startsWith('#EXTM3U')) {
      // Misconfigured content-type: it is really an HLS playlist.
      await readTextCapped(reader, 256 * 1024, firstChunk);
      return probeHls(url, {
        headers,
        timeoutMs,
        warmupBytes: options.warmupBytes ?? 512 * 1024,
        sampleMs: options.sampleMs ?? 1_500,
        signal: options.signal,
      });
    }

    if (/text\/html/i.test(contentType) && head.trimStart().startsWith('<')) {
      await reader.cancel();
      return {
        ok: false,
        status: response.status,
        protocol: 'http',
        contentType,
        error: '返回的是网页而不是视频流',
        checkedAt,
      };
    }

    const measured = await measureReader(
      reader,
      {
        warmupBytes: options.warmupBytes ?? 512 * 1024,
        sampleMs: options.sampleMs ?? 1_500,
        maxBytes: options.maxBytes ?? 4 * 1024 * 1024,
        deadline: Date.now() + timeoutMs,
      },
      firstChunk,
    );

    if (measured.bytes < 512) {
      return {
        ok: false,
        status: response.status,
        protocol: 'http',
        contentType,
        bytes: measured.bytes,
        error: measured.timedOut ? '请求超时' : '响应内容过短',
        checkedAt,
      };
    }

    const contentLength = Number(response.headers.get('content-length') ?? '0');
    return {
      ok: true,
      status: response.status,
      protocol: 'http',
      ttfbMs: measured.ttfbMs,
      elapsedMs: Math.round(now() - startedAt),
      speedKbps: measured.speedKbps,
      bytes: measured.bytes,
      contentType,
      quality: qualityFromResolution(contentType),
      loop: contentLength > 0 && contentLength < 2 * 1024 * 1024,
      error: measured.timedOut ? '采样超时，结果可能偏低' : undefined,
      checkedAt,
    };
  } catch (error) {
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      protocol: 'http',
      error: aborted ? '请求超时' : error instanceof Error ? error.message : String(error),
      checkedAt,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** Probe several URLs with a bounded worker pool. */
export async function probeMany(
  urls: Array<{ key: string; url: string; headers?: RequestHeaders }>,
  options: ProbeOptions & { concurrency?: number; onResult?: (key: string, result: ProbeResult) => void } = {},
): Promise<Map<string, ProbeResult>> {
  const results = new Map<string, ProbeResult>();
  const queue = [...urls];
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 16, 64));

  const worker = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const result = await probeStream(item.url, { ...options, headers: item.headers });
      results.set(item.key, result);
      options.onResult?.(item.key, result);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));
  return results;
}
