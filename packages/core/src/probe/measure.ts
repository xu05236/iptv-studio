import type { Quality } from '../types.js';

/** Read a response body while discarding the CDN warm-up burst. */
export interface MeasureOptions {
  /** bytes to ignore before sampling (CDN ramp-up makes the first 512KB lie) */
  warmupBytes: number;
  /** how long to sample after warm-up */
  sampleMs: number;
  /** hard byte cap */
  maxBytes: number;
  /** absolute epoch ms deadline */
  deadline: number;
}

export interface MeasureResult {
  bytes: number;
  ttfbMs: number;
  speedKbps: number;
  elapsedMs: number;
  timedOut: boolean;
}

/**
 * Measure steady-state throughput.
 *
 * The first `warmupBytes` (512KB by default) are thrown away because CDN and
 * ISP bursts make short samples wildly optimistic — a line that looks like
 * 20 Mbit/s for 300ms and then stalls is useless in a playlist.
 */
export async function measureReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: MeasureOptions,
  initial?: Uint8Array,
): Promise<MeasureResult> {
  const startedAt = now();
  let ttfbMs = 0;
  let bytes = 0;
  let warmupMark = 0;
  let measuredBytes = 0;
  let measuredMs = 0;
  let timedOut = false;

  const account = (length: number, at: number): void => {
    if (!ttfbMs) ttfbMs = Math.max(1, at - startedAt);
    bytes += length;
    if (warmupMark === 0) {
      if (bytes >= options.warmupBytes) warmupMark = at;
    } else {
      measuredBytes += length;
      measuredMs = at - warmupMark;
    }
  };

  try {
    if (initial?.byteLength) account(initial.byteLength, now());
    while (!(measuredMarkReached(measuredMs, options.sampleMs) || bytes >= options.maxBytes)) {
      const at = now();
      if (Date.now() > options.deadline) {
        timedOut = true;
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      account(value?.byteLength ?? 0, now());
      void at;
    }
  } catch {
    // a partial body is still a useful signal; callers decide what to do
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }

  const totalMs = Math.max(1, now() - startedAt - ttfbMs);
  // CDN bursts can deliver a segment in a few milliseconds; without a floor the
  // reported speed becomes absurd (e.g. 2 Gbit/s). Cap the claim and require a
  // meaningful window.
  const MIN_SAMPLE_MS = 500;
  const MAX_SPEED_KBPS = 100_000;
  const rawSpeed =
    measuredBytes > 0
      ? (measuredBytes * 8) / Math.max(measuredMs, MIN_SAMPLE_MS)
      : bytes > 0
        ? (bytes * 8) / Math.max(totalMs, MIN_SAMPLE_MS)
        : 0;
  const speedKbps = Math.min(MAX_SPEED_KBPS, rawSpeed);

  return {
    bytes,
    ttfbMs: Math.round(ttfbMs),
    speedKbps: Math.round(speedKbps),
    elapsedMs: Math.round(now() - startedAt),
    timedOut,
  };
}

function measuredMarkReached(measuredMs: number, sampleMs: number): boolean {
  return measuredMs >= sampleMs;
}

export async function measureBody(body: ReadableStream<Uint8Array>, options: MeasureOptions): Promise<MeasureResult> {
  return measureReader(body.getReader(), options);
}

export async function readTextCapped(
  source: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array> | null,
  maxBytes = 512 * 1024,
  initial?: Uint8Array,
): Promise<string> {
  const reader = source === null ? null : 'getReader' in source ? source.getReader() : source;
  if (!reader) return '';
  const chunks: Uint8Array[] = initial?.byteLength ? [initial] : [];
  let total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.byteLength) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } catch {
    /* ignore */
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  const merged = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, merged.byteLength - offset);
    merged.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= merged.byteLength) break;
  }
  return new TextDecoder().decode(merged);
}

export function qualityFromHeight(height?: number): Quality {
  if (!height || height <= 0) return 'unknown';
  if (height >= 2000) return '2160p';
  if (height >= 1400) return '1440p';
  if (height >= 1000) return '1080p';
  if (height >= 700) return '720p';
  if (height >= 460) return '480p';
  return 'sd';
}

export function qualityFromResolution(resolution?: string): Quality {
  if (!resolution) return 'unknown';
  const match = /(\d{3,4})\s*[x×]\s*(\d{3,4})/i.exec(resolution);
  if (match) return qualityFromHeight(Number(match[2]));
  if (/2160|4k/i.test(resolution)) return '2160p';
  if (/1440|2k/i.test(resolution)) return '1440p';
  if (/1080|fhd/i.test(resolution)) return '1080p';
  if (/720|hd/i.test(resolution)) return '720p';
  if (/480|sd/i.test(resolution)) return '480p';
  return 'unknown';
}

export function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
