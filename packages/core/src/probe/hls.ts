import type { ProbeResult } from '../types.js';
import { measureBody, readTextCapped, qualityFromHeight, now } from './measure.js';

export interface HlsVariant {
  uri: string;
  bandwidthKbps?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  codecs?: string;
}

export interface HlsSegment {
  uri: string;
  duration: number;
}

export interface HlsManifest {
  type: 'master' | 'media';
  variants: HlsVariant[];
  segments: HlsSegment[];
  targetDuration?: number;
  totalDuration: number;
  endList: boolean;
  encrypted: boolean;
  mapUri?: string;
  raw?: string;
}

/**
 * Parse an HLS playlist. No external dependency, tolerant of comments,
 * whitespace and relative URIs.
 */
export function parseHlsManifest(text: string, baseUrl: string): HlsManifest | null {
  const trimmed = text.replace(/^\uFEFF/, '').trimStart();
  if (!/^#EXTM3U/i.test(trimmed)) return null;

  const lines = trimmed.split(/\r?\n/);
  const variants: HlsVariant[] = [];
  const segments: HlsSegment[] = [];
  let targetDuration: number | undefined;
  let endList = false;
  let encrypted = false;
  let mapUri: string | undefined;
  let pendingVariant: Partial<HlsVariant> | null = null;
  let pendingDuration: number | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (/^#EXT-X-TARGETDURATION:/i.test(line)) {
      targetDuration = Number(line.split(':')[1]) || undefined;
      continue;
    }
    if (/^#EXT-X-ENDLIST/i.test(line)) {
      endList = true;
      continue;
    }
    if (/^#EXT-X-KEY:/i.test(line)) {
      if (!/METHOD=NONE/i.test(line)) encrypted = true;
      continue;
    }
    if (/^#EXT-X-MAP:/i.test(line)) {
      const uri = /URI="([^"]+)"/i.exec(line)?.[1];
      if (uri) mapUri = resolve(baseUrl, uri);
      continue;
    }
    if (/^#EXT-X-STREAM-INF:/i.test(line)) {
      const attrs = parseAttrList(line.slice(line.indexOf(':') + 1));
      const resolution = attrs['resolution'] ?? '';
      const size = /(\d+)\s*[x×]\s*(\d+)/i.exec(resolution);
      pendingVariant = {
        bandwidthKbps: attrs['bandwidth'] ? Math.round(Number(attrs['bandwidth']) / 1000) : undefined,
        width: size ? Number(size[1]) : undefined,
        height: size ? Number(size[2]) : undefined,
        frameRate: attrs['frame-rate'] ? Number(attrs['frame-rate']) : undefined,
        codecs: attrs['codecs'],
      };
      continue;
    }
    if (/^#EXTINF:/i.test(line)) {
      pendingDuration = Number(line.slice(8).split(',')[0]) || 0;
      continue;
    }
    if (line.startsWith('#')) continue;

    const uri = resolve(baseUrl, line);
    if (pendingVariant) {
      variants.push({ uri, ...pendingVariant });
      pendingVariant = null;
    } else if (pendingDuration !== null) {
      segments.push({ uri, duration: pendingDuration });
      pendingDuration = null;
    }
  }

  const totalDuration = segments.reduce((sum, segment) => sum + segment.duration, 0);
  if (variants.length && !segments.length) {
    return { type: 'master', variants, segments, targetDuration, totalDuration: 0, endList: false, encrypted, mapUri };
  }
  return {
    type: 'media',
    variants: [],
    segments,
    targetDuration,
    totalDuration,
    endList,
    encrypted,
    mapUri,
    raw: trimmed.slice(0, 2048),
  };
}

function parseAttrList(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    out[match[1]!.toLowerCase()] = match[2]!.replace(/^"|"$/g, '');
  }
  return out;
}

function resolve(base: string, relative: string): string {
  try {
    return new URL(relative, base).toString();
  } catch {
    return relative;
  }
}

export interface HlsProbeOptions {
  headers: HeadersInit;
  timeoutMs: number;
  warmupBytes: number;
  sampleMs: number;
  signal?: AbortSignal;
}

/**
 * Probe an HLS stream: fetch the manifest, follow the master playlist to the
 * highest bitrate rendition, then download the first segment to measure the
 * real throughput and confirm the stream is actually playable.
 */
export async function probeHls(url: string, options: HlsProbeOptions): Promise<ProbeResult> {
  const startedAt = now();
  const checkedAt = new Date().toISOString();
  const deadline = Date.now() + options.timeoutMs;

  try {
    const manifest = await fetchManifest(url, options, deadline);
    if (!manifest) {
      return { ok: false, protocol: 'hls', error: '返回内容不是有效的 HLS 播放列表', checkedAt };
    }

    let selected = manifest;
    let baseUrl = url;
    let variant: HlsVariant | undefined;
    if (manifest.type === 'master') {
      variant = pickBestVariant(manifest.variants);
      if (!variant) {
        return { ok: false, protocol: 'hls', error: 'master playlist 中没有可用码率', checkedAt };
      }
      baseUrl = variant.uri;
      const child = await fetchManifest(variant.uri, options, deadline);
      if (!child || child.type === 'master') {
        return { ok: false, protocol: 'hls', error: '子播放列表不可用', checkedAt, bandwidthKbps: variant.bandwidthKbps };
      }
      selected = child;
    }

    if (!selected.segments.length) {
      return { ok: false, protocol: 'hls', error: '播放列表中没有分片', checkedAt, bandwidthKbps: variant?.bandwidthKbps };
    }

    // Try the first two segments: some CDNs 404 the very first one on cold start.
    let measured: { bytes: number; ttfbMs: number; speedKbps: number } | null = null;
    let lastError = '';
    for (const segment of selected.segments.slice(0, 2)) {
      const remaining = deadline - Date.now();
      if (remaining <= 500) break;
      try {
        const response = await fetchWithTimeout(segment.uri, options, remaining);
        if (!response.ok || !response.body) {
          lastError = `分片 HTTP ${response.status}`;
          continue;
        }
        const result = await measureBody(response.body, {
          warmupBytes: Math.min(options.warmupBytes, 256 * 1024),
          sampleMs: Math.min(options.sampleMs, 1200),
          maxBytes: 3 * 1024 * 1024,
          deadline,
        });
        if (result.bytes > 0) {
          measured = result;
          break;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    if (!measured) {
      return {
        ok: false,
        protocol: 'hls',
        error: lastError || '分片无法下载',
        checkedAt,
        bandwidthKbps: variant?.bandwidthKbps,
      };
    }

    const loop = selected.endList && selected.totalDuration > 0 && selected.totalDuration <= 300 && selected.segments.length >= 3;
    let resolution = variant?.width && variant.height ? `${variant.width}x${variant.height}` : undefined;
    let height = variant?.height;

    // Many providers publish a bare media playlist without a master, but put
    // the quality in the path (`/720p/index.m3u8`). Use it as a fallback.
    if (!resolution) {
      try {
        const match = /(?:^|[/_.-])(\d{3,4})p(?:[/_.-]|$)/i.exec(new URL(url).pathname);
        if (match?.[1]) {
          height = Number(match[1]);
          resolution = `${height}p`;
        }
      } catch {
        /* ignore malformed URLs */
      }
    }

    return {
      ok: true,
      status: 200,
      protocol: 'hls',
      ttfbMs: Math.round(measured.ttfbMs),
      elapsedMs: Math.round(now() - startedAt),
      speedKbps: measured.speedKbps,
      bytes: measured.bytes,
      resolution,
      quality: qualityFromHeight(height),
      width: variant?.width,
      height,
      frameRate: variant?.frameRate,
      bandwidthKbps: variant?.bandwidthKbps,
      loop,
      durationSec: Math.round(selected.totalDuration),
      segments: selected.segments.length,
      contentType: 'application/vnd.apple.mpegurl',
      checkedAt,
    };
  } catch (error) {
    return {
      ok: false,
      protocol: 'hls',
      error: error instanceof Error ? (error.name === 'AbortError' ? '请求超时' : error.message) : String(error),
      checkedAt,
    };
  }
}

async function fetchManifest(url: string, options: HlsProbeOptions, deadline: number): Promise<HlsManifest | null> {
  const remaining = Math.max(1000, deadline - Date.now());
  const response = await fetchWithTimeout(url, options, remaining);
  if (!response.ok) throw new Error(`播放列表 HTTP ${response.status}`);
  const text = await readTextCapped(response.body, 512 * 1024);
  return parseHlsManifest(text, url);
}

async function fetchWithTimeout(url: string, options: HlsProbeOptions, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, {
      headers: options.headers,
      redirect: 'follow',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export function pickBestVariant(variants: HlsVariant[]): HlsVariant | undefined {
  if (!variants.length) return undefined;
  return [...variants].sort((a, b) => {
    const bandwidth = (b.bandwidthKbps ?? 0) - (a.bandwidthKbps ?? 0);
    if (bandwidth !== 0) return bandwidth;
    return (b.height ?? 0) - (a.height ?? 0);
  })[0];
}
