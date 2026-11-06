import type { PlaylistFormat } from '@iptv/core';

/**
 * F2: rewrite the playable line URLs inside an already-rendered subscription.
 *
 * Only lines that are actually playable URLs are touched (m3u/txt: bare URL
 * lines, json: `"url": "..."`), so EPG/logo URLs stay untouched.
 */
export async function applyProxyMode(
  body: string,
  format: PlaylistFormat,
  transform: (url: string) => Promise<string>,
): Promise<string> {
  if (format === 'm3u' || format === 'txt') {
    const out: string[] = [];
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && /^https?:\/\//i.test(trimmed)) {
        out.push(line.replace(trimmed, await transform(trimmed)));
      } else {
        out.push(line);
      }
    }
    return out.join('\n');
  }
  if (format === 'json') {
    const urls = new Map<string, string>();
    for (const match of body.matchAll(/"url"\s*:\s*"([^"]+)"/g)) {
      const value = match[1]!;
      if (/^https?:\/\//i.test(value) && !urls.has(value)) urls.set(value, await transform(value));
    }
    return body.replace(/"url"\s*:\s*"([^"]+)"/g, (full, value: string) => {
      const replaced = urls.get(value);
      return replaced ? `"url": ${JSON.stringify(replaced)}` : full;
    });
  }
  return body;
}
