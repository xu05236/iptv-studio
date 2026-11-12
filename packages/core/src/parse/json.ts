import type { ParsedSource, RawEntry, RequestHeaders } from '../types.js';
import { isStreamUrl, splitUrlHeaders } from '../util/url.js';
import { cleanLabel } from '../util/text.js';

const NAME_KEYS = ['name', 'title', 'tvgname', 'channelname', 'cname', 'showname', 'label'];
const URL_KEYS = ['url', 'urls', 'sources', 'streams', 'playbackurl', 'streamurl', 'playurl', 'address', 'addr', 'link', 'src', 'm3u8'];
const GROUP_KEYS = ['group', 'grouptitle', 'category', 'class', 'type', 'tag', 'typename'];
const LOGO_KEYS = ['logo', 'tvglogo', 'icon', 'pic', 'image', 'img'];
const TVG_KEYS = ['tvgid', 'tvg', 'epgid', 'epg', 'channelid'];
const CATCHUP_KEYS = ['catchup'];
const CATCHUP_SOURCE_KEYS = ['catchupsource', 'catchupsrc'];
const CATCHUP_DAYS_KEYS = ['catchupdays', 'timeshift'];
const GROUP_FALLBACK_KEYS = ['group', 'grouptitle', 'category', 'class', 'tag', 'typename'];
// Some portal APIs return per-channel paths such as `/tsfile/live/0001_1.m3u8?key=…`.
// They are resolved against the source URL after parsing.
const RELATIVE_PLAYABLE = /^\/(?!\/)[^\s]*\.(?:m3u8|mp4|flv|ts|mkv)(?:\?[^\s]*)?$/i;

function playable(url: string): boolean {
  return isStreamUrl(url) || RELATIVE_PLAYABLE.test(url);
}

function groupOf(map: Map<string, unknown>): string | undefined {
  for (const key of GROUP_FALLBACK_KEYS) {
    const value = map.get(key);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  // Numeric `type` values are internal ids, not a category.
  const type = map.get('type');
  return typeof type === 'string' && type.trim() && !/^\d+$/.test(type.trim()) ? type.trim() : undefined;
}

interface WalkContext {
  group?: string;
  depth: number;
}

/**
 * Parse JSON playlist shapes used in the wild: plain arrays, DIYP/TVBox
 * `{"lives":[{"group","channels":[{"name","urls"}]}]}`, wrapped `data/list`
 * payloads, and ad-hoc `{"频道名": ["url"]}` maps.
 */
export function parseJSONSource(text: string): ParsedSource {
  const warnings: string[] = [];
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (error) {
    return {
      kind: 'json',
      entries: [],
      epgUrls: [],
      warnings: [`JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const entries: RawEntry[] = [];
  walk(root, { depth: 0 }, entries, warnings);
  if (!entries.length) warnings.push('未解析到任何频道条目（支持数组、lives/channels、data/list 结构）');

  const epgUrls = collectEpgUrls(root);
  return { kind: 'json', entries, epgUrls, warnings };
}

function collectEpgUrls(root: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 3 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const normalized = key.toLowerCase();
      if (typeof value === 'string' && /^(epg|epgurl|epg_url|x-tvg-url|url-tvg)$/.test(normalized) && value.startsWith('http')) {
        out.push(value);
      } else if (typeof value === 'object') {
        visit(value, depth + 1);
      }
    }
  };
  visit(root, 0);
  return [...new Set(out)];
}

function walk(node: unknown, ctx: WalkContext, out: RawEntry[], warnings: string[]): void {
  if (ctx.depth > 6 || node === null || node === undefined) return;

  if (Array.isArray(node)) {
    for (const item of node) walk(item, { ...ctx, depth: ctx.depth + 1 }, out, warnings);
    return;
  }

  if (typeof node === 'string') {
    if (playable(node)) out.push({ name: '未命名频道', url: node, group: ctx.group });
    return;
  }

  if (typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  const map = new Map<string, unknown>();
  for (const [key, value] of Object.entries(record)) map.set(key.toLowerCase().replace(/[-_]/g, ''), value);

  // DIYP / TVBox live payload
  if (Array.isArray(map.get('lives'))) {
    for (const live of map.get('lives') as unknown[]) {
      if (!live || typeof live !== 'object') continue;
      const liveMap = lowerMap(live as Record<string, unknown>);
      const group = pick(liveMap, GROUP_KEYS) ?? pick(liveMap, NAME_KEYS) ?? ctx.group;
      const channels = liveMap.get('channels') ?? liveMap.get('list') ?? liveMap.get('items');
      if (Array.isArray(channels)) walk(channels, { group: cleanLabel(group ?? ''), depth: ctx.depth + 1 }, out, warnings);
    }
    return;
  }

  // TVBox site config is not a direct stream; report instead of silently failing.
  if (Array.isArray(map.get('sites')) && !looksLikeEntry(map)) {
    const sites = map.get('sites') as unknown[];
    warnings.push(`检测到 TVBox 站点配置（${sites.length} 个 site），api 不是直链，已跳过`);
    return;
  }

  if (looksLikeEntry(map)) {
    pushEntry(map, ctx, out);
    return;
  }

  // Generic map: {"CCTV1": ["url1","url2"]}
  if (!ctx.group && recordHasUrlArray(record)) {
    for (const [key, value] of Object.entries(record)) {
      if (!Array.isArray(value)) continue;
      const urls = value.filter((item): item is string => typeof item === 'string' && playable(item));
      for (const url of urls) out.push({ name: cleanLabel(key), url, group: ctx.group });
    }
    return;
  }

  const containerKeys = ['channels', 'channel', 'list', 'data', 'result', 'results', 'items', 'urls', 'groups', 'live', 'content'];
  // A group node like {"name":"央视","channels":[...]} has no stream URL of its
  // own. Pass its name down as the group so channels keep their category
  // (shapes such as {groups:[{name,channels:[{name,sources:[url]}]}]}).
  const groupLabel = pick(map, NAME_KEYS) ?? pick(map, GROUP_KEYS);
  const childGroup = groupLabel && !hasUrlValue(map) ? cleanLabel(groupLabel) : ctx.group;
  let descended = false;
  for (const key of containerKeys) {
    const value = map.get(key);
    if (Array.isArray(value)) {
      descended = true;
      walk(value, { ...ctx, group: childGroup, depth: ctx.depth + 1 }, out, warnings);
    }
  }
  if (descended) return;

  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') walk(value, { ...ctx, depth: ctx.depth + 1 }, out, warnings);
  }
}

function lowerMap(record: Record<string, unknown>): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const [key, value] of Object.entries(record)) map.set(key.toLowerCase().replace(/[-_]/g, ''), value);
  return map;
}

function pick(map: Map<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = map.get(key);
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function hasUrlValue(map: Map<string, unknown>): boolean {
  for (const key of URL_KEYS) {
    const value = map.get(key);
    if (typeof value === 'string' && playable(value)) return true;
    if (Array.isArray(value) && value.some((item) => typeof item === 'string' && playable(item))) return true;
  }
  return false;
}

function looksLikeEntry(map: Map<string, unknown>): boolean {
  return hasUrlValue(map);
}

function recordHasUrlArray(record: Record<string, unknown>): boolean {
  return Object.values(record).some(
    (value) => Array.isArray(value) && value.some((item) => typeof item === 'string' && playable(item)),
  );
}

function pushEntry(map: Map<string, unknown>, ctx: WalkContext, out: RawEntry[]): void {
  let rawUrl: unknown;
  for (const key of URL_KEYS) {
    const value = map.get(key);
    if (value !== undefined) {
      rawUrl = value;
      break;
    }
  }
  const urls: string[] = Array.isArray(rawUrl)
    ? rawUrl.filter((item): item is string => typeof item === 'string')
    : typeof rawUrl === 'string'
      ? [rawUrl]
      : [];
  if (!urls.length) return;

  const name = cleanLabel(pick(map, NAME_KEYS) ?? pick(map, TVG_KEYS) ?? '未命名频道');
  const group = cleanLabel(groupOf(map) ?? ctx.group ?? '') || undefined;
  const logo = pick(map, LOGO_KEYS);
  const tvgId = pick(map, TVG_KEYS);
  const headers = readHeaders(map);
  const catchup = pick(map, CATCHUP_KEYS);
  const catchupSource = pick(map, CATCHUP_SOURCE_KEYS);
  const days = Number(pick(map, CATCHUP_DAYS_KEYS) ?? '');

  for (const raw of urls) {
    if (typeof raw !== 'string') continue;
    const { url, headers: suffix } = splitUrlHeaders(raw);
    if (!playable(url)) continue;
    out.push({
      name,
      url,
      group,
      logo,
      tvgId,
      headers: { ...headers, ...suffix },
      catchup,
      catchupSource,
      catchupDays: Number.isFinite(days) && days > 0 ? days : undefined,
    });
  }
}

function readHeaders(map: Map<string, unknown>): RequestHeaders {
  const headers: RequestHeaders = {};
  const raw = map.get('headers');
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      const k = key.toLowerCase();
      if (k.includes('user-agent')) headers.userAgent = value;
      else if (k.includes('referer') || k.includes('referrer')) headers.referer = value;
      else if (k === 'origin') headers.origin = value;
      else if (k === 'cookie') headers.cookie = value;
    }
  }
  const ua = pick(map, ['useragent', 'ua']);
  if (ua) headers.userAgent ??= ua;
  const referer = pick(map, ['referer', 'referrer']);
  if (referer) headers.referer ??= referer;
  return headers;
}
