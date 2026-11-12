import type { ParsedSource, SourceKind } from '../types.js';
import { parseM3U } from './m3u.js';
import { parseTXT } from './txt.js';
import { parseHWCTC } from './hwctc.js';
import { parseJSONSource } from './json.js';

export type ParsedKind = Exclude<SourceKind, 'auto'>;

/** Cheap content sniffing; `hint` wins when the user explicitly picked a format. */
export function detectSourceKind(text: string, hint?: SourceKind | null): ParsedKind {
  if (hint && hint !== 'auto') return hint === 'tvbox' ? 'json' : hint;
  const sample = text.replace(/^\uFEFF/, '').trimStart().slice(0, 16_384);
  if (/^#EXTM3U/i.test(sample) || /#EXTINF:/i.test(sample)) return 'm3u';
  if (/^[[{]/.test(sample)) {
    try {
      JSON.parse(text);
      return 'json';
    } catch {
      if (/"(lives|channels|sites|urls)"\s*:/.test(sample)) return 'json';
    }
  }
  if (/#genre#/i.test(sample)) return 'txt';
  if (/^[^\n,，]{1,80}[,，]\s*(?:https?|rtsp|rtmp|udp|rtp):\/\//im.test(sample)) return 'txt';
  if (/^\s*(?:Authorization|Authentication)\b/im.test(sample)) return 'hwctc';
  return 'txt';
}

/** Parse a playlist body of any supported format. */
export interface ParseOptions {
  /** Absolute source URL; relative entry URLs are resolved against it. */
  baseUrl?: string;
}

function resolveEntryUrl(url: string, baseUrl: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return url;
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

/** Resolve relative entry URLs against an absolute source URL. */
export function resolveParsedUrls(parsed: ParsedSource, baseUrl: string): ParsedSource {
  return {
    ...parsed,
    entries: parsed.entries.map((entry) => ({ ...entry, url: resolveEntryUrl(entry.url, baseUrl) })),
  };
}

export function parseSource(text: string, hint?: SourceKind | null, options?: ParseOptions): ParsedSource {
  const kind = detectSourceKind(text, hint);
  let parsed: ParsedSource;
  switch (kind) {
    case 'm3u':
      parsed = parseM3U(text);
      break;
    case 'json':
      parsed = parseJSONSource(text);
      break;
    case 'hwctc':
      parsed = parseHWCTC(text);
      break;
    case 'txt':
    case 'tvbox':
    default:
      parsed = parseTXT(text);
      break;
  }
  return options?.baseUrl ? resolveParsedUrls(parsed, options.baseUrl) : parsed;
}

export { parseM3U, parseTXT, parseJSONSource, parseHWCTC };
