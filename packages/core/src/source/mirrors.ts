export interface MirrorCheck {
  urls: string[];
  error?: string;
}

/** Maximum number of mirror URLs a source may keep. */
export const MAX_MIRROR_URLS = 5;

/**
 * Normalize admin-supplied mirror URLs. Accepts an array or a JSON string, trims
 * blanks, dedupes, and rejects non-http(s) entries so the runner never loops on
 * an unusable scheme.
 */
export function normalizeMirrorUrls(input: unknown): MirrorCheck {
  if (input === null || input === undefined || input === '') return { urls: [] };
  let raw: unknown = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      raw = input.split(/[\s,]+/).filter(Boolean);
    }
  }
  if (!Array.isArray(raw)) return { urls: [], error: '备用地址必须是数组' };
  const urls: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { urls: [], error: '备用地址必须是字符串' };
    const value = item.trim();
    if (!value) continue;
    if (urls.includes(value)) continue;
    if (urls.length >= MAX_MIRROR_URLS) return { urls: [], error: `备用地址最多 ${MAX_MIRROR_URLS} 个` };
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return { urls: [], error: `备用地址不合法：${value}` };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { urls: [], error: '备用地址只支持 http(s)' };
    }
    urls.push(value);
  }
  return { urls };
}
