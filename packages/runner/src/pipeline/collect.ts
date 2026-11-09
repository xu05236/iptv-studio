import { effectiveRefreshHours, fetchText, filterSourceEntries, parseWithAdapter, type FetchErrorKind, type ParsedSource, type RawEntry, type SourceFilters } from '@iptv/core';
import type { ArtifactStore, SourceRecord } from '../store.js';
import type { RunLogger } from '../logger.js';
import { builtinPlaylist } from '../data/cctvOfficial.js';
import { insecureFetch } from '../lib/insecureFetch.js';

export interface CollectedSource {
  source: SourceRecord;
  entries: RawEntry[];
  parsed?: ParsedSource;
  fetched: boolean;
  notModified: boolean;
  error?: string;
  etag?: string | null;
  lastModified?: string | null;
  bytes: number;
  /** Classification of the last failure (see FetchErrorKind). */
  errorKind?: FetchErrorKind;
  attempts?: number;
  /** F4: body encoding used by the decoder (utf-8 / gbk / …). */
  encoding?: string;
  /** 0 = primary URL, 1+ = which mirror answered. */
  mirrorIndex?: number;
  /** 被源过滤规则丢弃的条目数。 */
  filtered?: number;
}

interface FetchResult {
  ok: boolean;
  status: number;
  text?: string;
  etag?: string | null;
  lastModified?: string | null;
  notModified?: boolean;
  error?: string;
  errorKind?: FetchErrorKind;
  attempts?: number;
  encoding?: string;
}

async function fetchPlaylist(
  url: string,
  etag?: string | null,
  lastModified?: string | null,
  conditional = true,
  headers?: Record<string, string>,
  timeoutMs = 45_000,
  insecure = false,
): Promise<FetchResult> {
  const attempt = async (skipVerify: boolean): Promise<FetchResult> => {
    const result = await fetchText(url, {
      etag: conditional ? etag : null,
      lastModified: conditional ? lastModified : null,
      headers,
      timeoutMs,
      maxBytes: 24 * 1024 * 1024,
      retries: 2,
      retryDelayMs: 800,
      fetchImpl: skipVerify ? insecureFetch : undefined,
    });
    return {
      ok: result.ok,
      status: result.status,
      text: result.text,
      etag: result.etag,
      lastModified: result.lastModified,
      notModified: result.notModified,
      error: result.error,
      errorKind: result.errorKind,
      attempts: result.attempts,
      encoding: result.encoding,
    };
  };
  let result = await attempt(insecure);
  // Many IPTV hosts serve playlists over https with an expired or mismatched
  // certificate. A TLS failure used to leave the source failing (and eventually
  // paused) forever; retry once without certificate verification, which is the
  // same effect as the per-source 「允许证书错误」toggle.
  if (!insecure && result.errorKind === 'tls') {
    const recovered = await attempt(true);
    if (recovered.ok || recovered.notModified) result = recovered;
  }
  return result;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * F5: 按 `fetch_concurrency` 并发尝试同源的多个地址，取第一个成功（ok / 304）；
 * 全部失败时按地址顺序返回第一个错误，保持与顺序尝试一致的错误优先级。
 */
async function firstAttempt(
  attempts: Array<() => Promise<FetchResult>>,
  startIndex: number,
): Promise<{ index: number; result: FetchResult }> {
  return await new Promise((resolve) => {
    let pending = attempts.length;
    const failures: Array<{ index: number; result: FetchResult }> = [];
    if (!pending) {
      resolve({ index: startIndex, result: { ok: false, status: 0, error: '没有可用地址' } });
      return;
    }
    attempts.forEach((run, offset) => {
      const index = startIndex + offset;
      run()
        .then((result) => {
          if (result.ok || result.notModified) {
            resolve({ index, result });
            return;
          }
          failures.push({ index, result });
          if (--pending === 0) resolve(failures.sort((a, b) => a.index - b.index)[0]);
        })
        .catch(() => {
          failures.push({ index, result: { ok: false, status: 0, error: '抓取异常', errorKind: 'network' } });
          if (--pending === 0) resolve(failures.sort((a, b) => a.index - b.index)[0]);
        });
    });
  });
}

/**
 * 每个源的抓取间隔：自定义值优先（24 小时是历史默认值，视为“跟随分档”）；
 * 否则收藏源 12 小时、7 天内新增源 24 小时、普通源 72 小时。
 */
function refreshHoursFor(source: SourceRecord): number {
  return effectiveRefreshHours({ refreshHours: source.refresh_hours, weight: source.weight, createdAt: source.created_at });
}

function parseMirrorUrls(value: SourceRecord['mirror_urls']): string[] {
  if (!value) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((url): url is string => typeof url === 'string' && /^https?:\/\//i.test(url));
  } catch {
    return [];
  }
}

/**
 * Fetch one configured source (remote URL or R2-stored upload) and parse it.
 */
export async function collectSource(source: SourceRecord, store: ArtifactStore, logger: RunLogger): Promise<CollectedSource> {
  const base: CollectedSource = {
    source,
    entries: [],
    fetched: false,
    notModified: false,
    bytes: 0,
    etag: source.etag,
    lastModified: source.last_modified,
  };

  let text: string | null = null;

  const refreshHours = refreshHoursFor(source);
  const forceFetch =
    process.env.FETCH_FORCE === '1' ||
    process.env.FETCH_FORCE === 'true' ||
    process.env.PROBE_FORCE === '1' ||
    process.env.PROBE_FORCE === 'true';
  if (!forceFetch && refreshHours > 0 && source.last_fetch_at && (source.entry_count ?? 0) > 0) {
    const ageHours = (Date.now() - new Date(source.last_fetch_at).getTime()) / 3_600_000;
    if (ageHours < refreshHours) {
      logger.info('源未到更新间隔，复用上一轮线路', { source: source.name, ageHours: Math.round(ageHours), refreshHours });
      return { ...base, fetched: false, notModified: true };
    }
  }

  if (source.r2_key) {
    text = await store.getText(source.r2_key);
    if (text === null) {
      logger.warn('上传源内容缺失', { source: source.name, key: source.r2_key });
      return { ...base, error: 'R2 内容缺失' };
    }
  } else if (source.url?.startsWith('builtin://')) {
    text = builtinPlaylist(source.url);
    if (!text) return { ...base, error: `未知内置源 ${source.url}` };
    base.fetched = true;
  } else if (source.fetch_mode === 'worker' && source.url && /^https?:\/\//i.test(source.url)) {
    // F3: Worker 代拉。Actions 出口被源站/CDN 拦截时由 Worker 取正文，本地照常解析。
    try {
      const remote = await store.fetchRemoteSource(source.id);
      if (remote.notModified) {
        logger.info('源未变化 (304, Worker 代拉)', { source: source.name });
        return { ...base, fetched: true, notModified: true };
      }
      if (!remote.text) return { ...base, error: remote.error ?? 'Worker 代拉失败' };
      text = remote.text;
      base.fetched = true;
      base.encoding = remote.encoding;
      base.etag = remote.etag ?? null;
      base.lastModified = remote.lastModified ?? null;
      if (remote.mirrorIndex) logger.info(`已使用 Worker 代拉（备用 #${remote.mirrorIndex}）`, { source: source.name });
    } catch (error) {
      return { ...base, error: `Worker 代拉失败：${error instanceof Error ? error.message : String(error)}` };
    }
  } else if (source.url) {
    let requestHeaders: Record<string, string> | undefined;
    try {
      const parsed = typeof source.request_headers === 'string' ? JSON.parse(source.request_headers) : source.request_headers;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) requestHeaders = parsed as Record<string, string>;
    } catch {
      requestHeaders = undefined;
    }
    // F5: per-source fetch parameters (timeout / concurrency / polite delay).
    const timeoutMs = clamp(Number(source.fetch_timeout_ms) || 45_000, 2_000, 120_000);
    const concurrency = clamp(Math.floor(Number(source.fetch_concurrency) || 1), 1, 4);
    const delayMs = clamp(Number(source.fetch_delay_ms) || 0, 0, 5_000);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const candidates = [source.url, ...parseMirrorUrls(source.mirror_urls)];
    const insecure = Boolean(Number(source.allow_insecure_tls) || 0);
    const errors: string[] = [];
    let usedIndex = 0;
    for (let start = 0; start < candidates.length; start += concurrency) {
      const batch = candidates.slice(start, start + concurrency);
      const outcome = await firstAttempt(
        batch.map((url, offset) => {
          const index = start + offset;
          const conditional = index === 0 && !forceFetch;
          return () => fetchPlaylist(
            url,
            conditional ? source.etag : null,
            conditional ? source.last_modified : null,
            conditional,
            requestHeaders,
            timeoutMs,
            insecure,
          );
        }),
        start,
      );
      const fetched = outcome.result;
      const index = outcome.index;
      if (fetched.notModified) {
        logger.info('源未变化 (304)', { source: source.name });
        return { ...base, fetched: true, notModified: true };
      }
      if (fetched.ok && fetched.text) {
        text = fetched.text;
        base.etag = index === 0 ? fetched.etag ?? null : null;
        base.lastModified = index === 0 ? fetched.lastModified ?? null : null;
        base.fetched = true;
        usedIndex = index;
        base.mirrorIndex = index;
        base.encoding = fetched.encoding;
        break;
      }
      errors.push(`#${index + 1} ${fetched.error ?? fetched.status}`);
      if (fetched.errorKind) {
        // Prefer the most actionable classification: a challenge on any URL
        // explains every subsequent failure better than an HTTP code.
        if (fetched.errorKind === 'challenge' || !base.errorKind) base.errorKind = fetched.errorKind;
      }
      base.attempts = (base.attempts ?? 0) + (fetched.attempts ?? 1);
    }
    if (!text) {
      logger.warn('抓取失败', { source: source.name, error: errors.join('；') });
      return { ...base, error: errors.join('；') || '抓取失败', errorKind: base.errorKind ?? 'network' };
    }
    if (usedIndex > 0) {
      logger.warn('主地址失败，已使用备用地址', { source: source.name, used: usedIndex + 1, errors });
    }
  } else {
    return { ...base, error: '源没有地址和内容' };
  }

  const parsed = parseWithAdapter(text, source.kind);
  if (parsed.warnings.length) {
    logger.warn('解析警告', { source: source.name, warnings: parsed.warnings.slice(0, 3) });
  }
  let filters: SourceFilters | null = null;
  try {
    filters = typeof source.filters === 'string' ? (JSON.parse(source.filters) as SourceFilters) : (source.filters ?? null);
  } catch {
    filters = null;
  }
  const filtered = filterSourceEntries(parsed.entries, filters);
  if (filtered.dropped) logger.info('源过滤', { source: source.name, kept: filtered.entries.length, dropped: filtered.dropped });
  logger.info('源解析完成', { source: source.name, kind: parsed.kind, entries: filtered.entries.length });

  return {
    ...base,
    fetched: true,
    parsed: { ...parsed, entries: filtered.entries },
    entries: filtered.entries,
    filtered: filtered.dropped,
    bytes: text.length,
    ...(parsed.entries.length === 0 ? { error: '内容不是播放列表（解析出 0 条）', errorKind: 'not_playlist' as FetchErrorKind } : {}),
  };
}
