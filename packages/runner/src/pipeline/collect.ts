import { effectiveRefreshHours, fetchText, filterSourceEntries, parseSource, type ParsedSource, type RawEntry, type SourceFilters } from '@iptv/core';
import type { ArtifactStore, SourceRecord } from '../store.js';
import type { RunLogger } from '../logger.js';
import { builtinPlaylist } from '../data/cctvOfficial.js';

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
}

interface FetchResult {
  ok: boolean;
  status: number;
  text?: string;
  etag?: string | null;
  lastModified?: string | null;
  notModified?: boolean;
  error?: string;
}

async function fetchPlaylist(
  url: string,
  etag?: string | null,
  lastModified?: string | null,
  conditional = true,
  headers?: Record<string, string>,
): Promise<FetchResult> {
  const result = await fetchText(url, {
    etag: conditional ? etag : null,
    lastModified: conditional ? lastModified : null,
    headers,
    timeoutMs: 45_000,
    maxBytes: 24 * 1024 * 1024,
    retries: 0,
  });
  return {
    ok: result.ok,
    status: result.status,
    text: result.text,
    etag: result.etag,
    lastModified: result.lastModified,
    notModified: result.notModified,
    error: result.error,
  };
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
  const forceFetch = process.env.PROBE_FORCE === '1' || process.env.PROBE_FORCE === 'true';
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
  } else if (source.url) {
    let requestHeaders: Record<string, string> | undefined;
    try {
      const parsed = typeof source.request_headers === 'string' ? JSON.parse(source.request_headers) : source.request_headers;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) requestHeaders = parsed as Record<string, string>;
    } catch {
      requestHeaders = undefined;
    }
    const candidates = [source.url, ...parseMirrorUrls(source.mirror_urls)];
    const errors: string[] = [];
    let usedIndex = 0;
    for (let index = 0; index < candidates.length; index++) {
      const conditional = index === 0 && !forceFetch;
      const fetched = await fetchPlaylist(
        candidates[index],
        conditional ? source.etag : null,
        conditional ? source.last_modified : null,
        conditional,
        requestHeaders,
      );
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
        break;
      }
      errors.push(`#${index + 1} ${fetched.error ?? fetched.status}`);
    }
    if (!text) {
      logger.warn('抓取失败', { source: source.name, error: errors.join('；') });
      return { ...base, error: errors.join('；') || '抓取失败' };
    }
    if (usedIndex > 0) {
      logger.warn('主地址失败，已使用备用地址', { source: source.name, used: usedIndex + 1, errors });
    }
  } else {
    return { ...base, error: '源没有地址和内容' };
  }

  const parsed = parseSource(text, source.kind as never);
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
    bytes: text.length,
  };
}
