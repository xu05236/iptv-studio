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
export function parseSource(text: string, hint?: SourceKind | null): ParsedSource {
  const kind = detectSourceKind(text, hint);
  switch (kind) {
    case 'm3u':
      return parseM3U(text);
    case 'json':
      return parseJSONSource(text);
    case 'hwctc':
      return parseHWCTC(text);
    case 'txt':
    case 'tvbox':
    default:
      return parseTXT(text);
  }
}

export { parseM3U, parseTXT, parseJSONSource, parseHWCTC };
