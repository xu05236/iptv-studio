import type { ParsedSource, RawEntry } from '../types.js';
import { isStreamUrl, splitUrlHeaders } from '../util/url.js';
import { cleanLabel } from '../util/text.js';
import { splitLines } from './m3u.js';

/**
 * TXT / "DIYP" style lists:
 *
 *   央视,#genre#
 *   CCTV-1 综合,http://a/live.m3u8
 *   CCTV-2 财经,http://b/live.m3u8#http://c/live.m3u8
 *
 * Also tolerates full-width commas, `|` separators, `$` separated Huawei rows
 * and trailing `,` padding.
 */
export function parseTXT(text: string): ParsedSource {
  const entries: RawEntry[] = [];
  const warnings: string[] = [];
  let group = '未分组';

  for (const rawLine of splitLines(text)) {
    const line = rawLine.trim();
    if (!line) continue;

    const genre = /^(.*?)[,，]\s*#genre#\s*$/i.exec(line);
    if (genre) {
      group = cleanLabel(genre[1]!) || '未分组';
      continue;
    }
    if (/^#genre#$/i.test(line)) continue;
    if (line.startsWith('#') || line.startsWith('//')) continue;

    const row = parseRow(line);
    if (!row) continue;
    const { name, urls } = row;
    if (!urls.length) {
      warnings.push(`缺少可用地址: ${line.slice(0, 80)}`);
      continue;
    }
    for (const url of urls) {
      entries.push({ name, url, group });
    }
  }

  if (!entries.length) warnings.push('未解析到任何频道条目');
  return { kind: 'txt', entries, epgUrls: [], warnings };
}

/** Split one TXT row into a channel name and its stream urls. */
export function parseRow(line: string): { name: string; urls: string[] } | null {
  let name = '';
  let rest = '';
  const comma = firstIndexOf(line, [',', '，']);
  if (comma > 0) {
    name = line.slice(0, comma);
    rest = line.slice(comma + 1);
  } else {
    const pipe = firstIndexOf(line, ['|', '｜', '$']);
    if (pipe > 0) {
      name = line.slice(0, pipe);
      rest = line.slice(pipe + 1);
    } else if (isStreamUrl(line)) {
      // bare URL list, name it after its last path segment
      name = nameFromUrl(line);
      rest = line;
    } else {
      return null;
    }
  }

  name = cleanLabel(name).replace(/^["'#]+|["']+$/g, '').trim();
  if (!name) name = nameFromUrl(rest);
  const urls = splitUrls(rest);
  return { name, urls };
}

function firstIndexOf(input: string, separators: string[]): number {
  let best = -1;
  for (const sep of separators) {
    const at = input.indexOf(sep);
    if (at > 0 && (best === -1 || at < best)) best = at;
  }
  return best;
}

function splitUrls(rest: string): string[] {
  const out: string[] = [];
  const chunks = rest.split(/#|\s+/).map((item) => item.trim()).filter(Boolean);
  for (const chunk of chunks) {
    // `url1,url2` only when both halves really are urls (commas appear in queries)
    if (chunk.split('://').length > 2) {
      for (const piece of chunk.split(',')) {
        const { url } = splitUrlHeaders(piece.trim().replace(/,+$/, ''));
        if (isStreamUrl(url)) out.push(piece.trim().replace(/,+$/, ''));
      }
    } else {
      const cleaned = chunk.replace(/,+$/, '');
      const { url } = splitUrlHeaders(cleaned);
      if (isStreamUrl(url)) out.push(cleaned);
    }
  }
  return out;
}

function nameFromUrl(raw: string): string {
  const { url } = splitUrlHeaders(raw);
  const path = url.split('?')[0] ?? url;
  const last = path.split('/').filter(Boolean).pop() ?? '';
  return cleanLabel(last.replace(/\.[a-z0-9]{2,5}$/i, '')) || '未命名频道';
}
