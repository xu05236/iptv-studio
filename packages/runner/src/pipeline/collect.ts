import { filterSourceEntries, parseSource, readTextCapped, type ParsedSource, type RawEntry, type SourceFilters } from '@iptv/core';
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

async function fetchPlaylist(url: string, etag?: string | null, lastModified?: string | null): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), 45_000);
  const baseHeaders: Record<string, string> = {
    'User-Agent': 'IPTV-Studio-Runner/0.1',
    Accept: 'application/json, text/plain, application/x-mpegURL, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
  };
  const request = (conditional: boolean): Promise<Response> => {
    const headers = { ...baseHeaders };
    if (conditional && etag) headers['If-None-Match'] = etag;
    if (conditional && lastModified) headers['If-Modified-Since'] = lastModified;
    return fetch(url, { headers, redirect: 'follow', signal: controller.signal });
  };

  try {
    let response = await request(true);
    // A 304 is only useful when we keep a local copy of the body. The runner
    // does not cache source text, so re-fetch unconditionally to get content.
    if (response.status === 304) response = await request(false);
    if (response.status === 304) return { ok: true, status: 304, notModified: true, etag, lastModified };
    if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}` };
    const text = await readTextCapped(response.body, 24 * 1024 * 1024);
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

/** Fetch one configured source (remote URL or R2-stored upload) and parse it. */
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

  const refreshHours = Number(source.refresh_hours ?? 24) || 0;
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
    const fetched = await fetchPlaylist(source.url, source.etag, source.last_modified);
    if (fetched.notModified) {
      logger.info('源未变化 (304)', { source: source.name });
      return { ...base, fetched: true, notModified: true };
    }
    if (!fetched.ok || !fetched.text) {
      logger.warn('抓取失败', { source: source.name, error: fetched.error });
      return { ...base, error: fetched.error ?? '抓取失败', etag: fetched.etag, lastModified: fetched.lastModified };
    }
    text = fetched.text;
    base.etag = fetched.etag ?? null;
    base.lastModified = fetched.lastModified ?? null;
    base.fetched = true;
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
