import { parseSource, readTextCapped, type ParsedSource, type RawEntry } from '@iptv/core';
import type { ArtifactStore, SourceRecord } from '../store.js';
import type { RunLogger } from '../logger.js';

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
  const headers: Record<string, string> = {
    'User-Agent': 'IPTV-Studio-Runner/0.1',
    Accept: 'application/json, text/plain, application/x-mpegURL, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
  };
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;

  try {
    const response = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
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

  if (source.r2_key) {
    text = await store.getText(source.r2_key);
    if (text === null) {
      logger.warn('上传源内容缺失', { source: source.name, key: source.r2_key });
      return { ...base, error: 'R2 内容缺失' };
    }
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
  logger.info('源解析完成', { source: source.name, kind: parsed.kind, entries: parsed.entries.length });

  return {
    ...base,
    fetched: true,
    parsed,
    entries: parsed.entries,
    bytes: text.length,
  };
}
