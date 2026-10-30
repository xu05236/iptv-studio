import type { ArtifactStore } from '../store.js';
import type { RunLogger } from '../logger.js';

const CACHE_KEY = 'state/logo-files.json';
const CACHE_DAYS = 7;

export function normalizeLogoName(value: string): string {
  return value
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\d{3,4}[pPiI]\b/g, '')
    .replace(/(高清|超清|标清|频道|电视台|卫视高清)/g, '')
    .replace(/[\s\-_·・/\\]+/g, '')
    .replace(/[《》【】\[\]]/g, '')
    .trim()
    .toLowerCase();
}

/** Best filename match for a channel name, or undefined. Exact beats contains. */
export function matchLogoFile(name: string, files: string[]): string | undefined {
  const target = normalizeLogoName(name);
  if (!target) return undefined;
  const ranked = files
    .map((file) => ({ file, base: normalizeLogoName(file.replace(/\.png$/i, '')) }))
    .filter((item) => item.base.length >= 2)
    .map((item) => {
      if (item.base === target) return { ...item, score: 1000 };
      if (item.base.length < 3 || target.length < 3) return { ...item, score: 0 };
      if (item.base.includes(target)) return { ...item, score: 500 - (item.base.length - target.length) };
      if (target.includes(item.base)) return { ...item, score: 400 - (target.length - item.base.length) };
      return { ...item, score: 0 };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.file;
}

/** Cache the pack filename list in KV; the API is only hit once a week. */
export async function loadLogoFiles(store: ArtifactStore, logger: RunLogger): Promise<string[]> {
  const cached = await store.getJson<{ generatedAt: string; files: string[] }>(CACHE_KEY);
  if (cached?.files?.length && Date.now() - Date.parse(cached.generatedAt) < CACHE_DAYS * 86_400_000) {
    return cached.files;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const response = await fetch('https://api.github.com/repos/fanmingming/live/contents/tv', {
      headers: { 'User-Agent': 'iptv-studio-runner' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as Array<{ name?: string; type?: string }>;
    const files = payload
      .filter((item) => item.type === 'file' && item.name?.toLowerCase().endsWith('.png'))
      .map((item) => item.name!)
      .sort();
    if (!files.length) throw new Error('台标目录为空');
    await store.put(CACHE_KEY, JSON.stringify({ generatedAt: new Date().toISOString(), files }), 'application/json');
    logger.info('台标文件名缓存更新', { files: files.length });
    return files;
  } catch (error) {
    logger.warn('台标目录获取失败，使用缓存', { error: error instanceof Error ? error.message : String(error) });
    return cached?.files ?? [];
  }
}
