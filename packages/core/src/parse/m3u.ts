import type { ParsedSource, RawEntry, RequestHeaders } from '../types.js';
import { splitUrlHeaders, isStreamUrl } from '../util/url.js';
import { cleanLabel } from '../util/text.js';

/** Split M3U into logical lines (handles CRLF, BOM and bare CR). */
export function splitLines(text: string): string[] {
  return text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
}

/**
 * Parse `key="value"` / `key='value'` / `key=value` attribute lists.
 * Values may contain commas, spaces and `=` when quoted.
 */
export function parseAttributes(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z0-9_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,"']+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    const key = match[1]!.toLowerCase();
    const value = (match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (value) attrs[key] = value;
  }
  return attrs;
}

/** `#EXTINF:-1 tvg-id="a",Name, with comma` -> { attrs, title } */
export function splitExtinf(line: string): { attrs: Record<string, string>; title: string } | null {
  const body = line.replace(/^#EXTINF:\s*/i, '');
  let quote: string | null = null;
  let commaAt = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ',') {
      commaAt = i;
      break;
    }
  }
  const head = commaAt >= 0 ? body.slice(0, commaAt) : body;
  const title = commaAt >= 0 ? body.slice(commaAt + 1) : '';
  return { attrs: parseAttributes(head), title: cleanLabel(title) };
}

function headerFromVlc(key: string, value: string, headers: RequestHeaders): void {
  switch (key) {
    case 'http-user-agent':
    case 'user-agent':
      headers.userAgent = value;
      break;
    case 'http-referrer':
    case 'http-referer':
    case 'referer':
      headers.referer = value;
      break;
    case 'http-origin':
    case 'origin':
      headers.origin = value;
      break;
    case 'http-cookie':
    case 'cookie':
      headers.cookie = value;
      break;
    default:
      break;
  }
}

interface PendingEntry {
  name: string;
  group?: string;
  logo?: string;
  tvgId?: string;
  tvgName?: string;
  catchup?: string;
  catchupSource?: string;
  catchupDays?: number;
  headers: RequestHeaders;
  extras: Record<string, string>;
}

/** Parse an M3U / M3U8 playlist (EXTINF based, VLC/Kodi attributes included). */
export function parseM3U(text: string): ParsedSource {
  const entries: RawEntry[] = [];
  const epgUrls: string[] = [];
  const warnings: string[] = [];
  let current: PendingEntry | null = null;
  let stickyGroup: string | undefined;

  for (const rawLine of splitLines(text)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^#EXTM3U/i.test(line)) {
      const attrs = parseAttributes(line.slice(7));
      for (const key of ['x-tvg-url', 'url-tvg', 'tvg-url', 'epg-url']) {
        const value = attrs[key];
        if (value) epgUrls.push(...value.split(',').map((item) => item.trim()).filter(Boolean));
      }
      continue;
    }

    if (/^#EXTINF:/i.test(line)) {
      const parsed = splitExtinf(line);
      if (!parsed) continue;
      const a = parsed.attrs;
      const days = Number(a['catchup-days'] ?? a['timeshift'] ?? '');
      stickyGroup = a['group-title'] ?? stickyGroup;
      current = {
        name: parsed.title || cleanLabel(a['tvg-name'] ?? a['tvg_name'] ?? ''),
        group: a['group-title'] ?? stickyGroup,
        logo: a['tvg-logo'] ?? a['logo'],
        tvgId: a['tvg-id'] ?? a['tvg_id'],
        tvgName: a['tvg-name'] ?? a['tvg_name'],
        catchup: a['catchup'],
        catchupSource: a['catchup-source'],
        catchupDays: Number.isFinite(days) && days > 0 ? days : undefined,
        headers: {},
        extras: {},
      };
      continue;
    }

    if (/^#EXTGRP:/i.test(line)) {
      stickyGroup = cleanLabel(line.slice(8));
      if (current) current.group = stickyGroup;
      continue;
    }

    if (/^#EXTVLCOPT:/i.test(line)) {
      const body = line.slice(11);
      const eq = body.indexOf('=');
      if (eq > 0 && current) {
        headerFromVlc(body.slice(0, eq).trim().toLowerCase(), body.slice(eq + 1).trim(), current.headers);
      }
      continue;
    }

    if (/^#KODIPROP:/i.test(line)) {
      const body = line.slice(10);
      const eq = body.indexOf('=');
      if (eq > 0 && current) current.extras[body.slice(0, eq).trim()] = body.slice(eq + 1).trim();
      continue;
    }

    if (line.startsWith('#')) continue;

    if (!isStreamUrl(line)) {
      if (current) warnings.push(`无法识别的地址: ${line.slice(0, 80)}`);
      continue;
    }

    const { url, headers } = splitUrlHeaders(line);
    const name = current?.name?.trim() || current?.tvgName?.trim() || '未命名频道';
    entries.push({
      name,
      url,
      group: current?.group,
      logo: current?.logo,
      tvgId: current?.tvgId,
      tvgName: current?.tvgName,
      catchup: current?.catchup,
      catchupSource: current?.catchupSource,
      catchupDays: current?.catchupDays,
      headers: { ...current?.headers, ...headers },
      extras: current?.extras,
    });
    // Keep `current` so playlists that emit several URLs after one EXTINF work.
  }

  if (!entries.length) warnings.push('未解析到任何频道条目');
  return { kind: 'm3u', entries, epgUrls, warnings };
}
