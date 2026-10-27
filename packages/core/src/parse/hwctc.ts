import type { ParsedSource, RawEntry } from '../types.js';
import { isStreamUrl, splitUrlHeaders } from '../util/url.js';
import { cleanLabel } from '../util/text.js';
import { splitLines } from './m3u.js';

/**
 * Huawei / set-top-box export ("HWCTC" / JSP) is usually a CSV-ish channel
 * table with an authentication preamble:
 *
 *   Authentication,UserID=xx,CorpID=yy
 *   CCTV-1,rtsp://10.0.0.1:554/PLTV/...sdp
 *   CCTV-2,rtsp://...
 *
 * Some exporters use `$` or `,` padding, and put the URL in the second column.
 */
export function parseHWCTC(text: string): ParsedSource {
  const entries: RawEntry[] = [];
  const warnings: string[] = [];

  for (const rawLine of splitLines(text)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    if (/^authentication\b/i.test(line)) {
      warnings.push('检测到鉴权段（Authentication），请确认线路无需额外鉴权');
      continue;
    }
    if (/^(userid|corpid|stbid|token)\s*=/i.test(line)) continue;

    const columns = line.split(/[,，$]/).map((col) => col.trim()).filter(Boolean);
    const urlIndex = columns.findIndex((col) => isStreamUrl(col));
    if (urlIndex <= 0) continue;
    const name = cleanLabel(columns.slice(0, urlIndex).join(' ')) || '未命名频道';
    const { url } = splitUrlHeaders(columns[urlIndex]!);
    if (!url) continue;
    entries.push({ name, url, group: '未分组' });
  }

  if (!entries.length) warnings.push('未解析到任何频道条目（华为 JSP/HWCTC 格式）');
  return { kind: 'hwctc', entries, epgUrls: [], warnings };
}
