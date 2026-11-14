import { channelIdentityKey, cleanLabel, nfkc, normalizeChannelName, stripNoise } from '../util/text.js';

/** Minimal channel shape needed to plan duplicate merges. */
export interface ChannelMergeItem {
  id: string;
  name: string;
  group?: string | null;
  tvgId?: string | null;
  lines?: number;
  alive?: number;
  enabled?: boolean;
}

export interface ChannelMergePlan {
  key: string;
  into: ChannelMergeItem;
  from: ChannelMergeItem[];
  names: string[];
  lines: number;
  alive: number;
}

export interface ChannelMergePlanResult {
  plans: ChannelMergePlan[];
  skippedAmbiguous: number;
}

/** Content groups where duplicate names are common and merging is not useful. */
const SKIP_GROUPS = new Set(['虎牙频道', '斗鱼频道', 'YY频道', '成人']);

const SPEED_SUFFIX = /[（(]\s*\d+(?:\.\d+)?\s*(?:MB|KB)\s*[/／]\s*s\s*[)）]\s*$/i;

/** True when the raw name carries quality/speed decoration that can be safely dropped. */
export function hasChannelNameNoise(name: string): boolean {
  const base = cleanLabel(name);
  if (!base) return false;
  if (SPEED_SUFFIX.test(base)) return true;
  const lower = nfkc(base).toLowerCase();
  const stripped = stripNoise(lower).replace(/\s+/g, '');
  return stripped !== lower.replace(/\s+/g, '');
}

function rank(item: ChannelMergeItem): number[] {
  return [
    item.tvgId ? 1 : 0,
    hasChannelNameNoise(item.name) ? 0 : 1,
    item.enabled === false ? 0 : 1,
    item.alive ?? 0,
    item.lines ?? 0,
    -(cleanLabel(item.name).length || 0),
  ];
}

function compareRank(left: ChannelMergeItem, right: ChannelMergeItem): number {
  const a = rank(left);
  const b = rank(right);
  for (let index = 0; index < a.length; index += 1) {
    const diff = (b[index] ?? 0) - (a[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return left.id.localeCompare(right.id);
}

/**
 * Fold `安徽卫视 (0.001 MB/s)`-style duplicates into the clean channel.
 * Groups whose names are already identical are left alone: two different
 * local stations called `综合` must not be merged just because they share a key.
 */
export function planChannelMerges(items: ChannelMergeItem[]): ChannelMergePlanResult {
  const groups = new Map<string, ChannelMergeItem[]>();
  for (const item of items) {
    const name = cleanLabel(item.name);
    if (!name) continue;
    const key = channelIdentityKey(name);
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push({ ...item, name });
    else groups.set(key, [{ ...item, name }]);
  }

  const plans: ChannelMergePlan[] = [];
  let skippedAmbiguous = 0;
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    if (!list.some((item) => hasChannelNameNoise(item.name))) {
      skippedAmbiguous += 1;
      continue;
    }
    const sorted = [...list].sort(compareRank);
    const into = sorted[0]!;
    if (SKIP_GROUPS.has(into.group ?? '')) continue;
    const from = sorted.slice(1);
    if (from.some((item) => SKIP_GROUPS.has(item.group ?? ''))) continue;
    plans.push({
      key,
      into,
      from,
      names: list.map((item) => item.name),
      lines: from.reduce((sum, item) => sum + (item.lines ?? 0), 0),
      alive: from.reduce((sum, item) => sum + (item.alive ?? 0), 0),
    });
  }
  plans.sort((left, right) => right.from.length - left.from.length);
  return { plans, skippedAmbiguous };
}

/** Convenience for callers that only need the merge keys. */
export function mergeKeyOf(name: string): string {
  return channelIdentityKey(name);
}

export interface LineChannelLike {
  channelId?: string | null;
  key?: string | null;
}

export interface LineRemapResult {
  changed: number;
  movedKeys: Map<string, string[]>;
}

/**
 * Remap many channel ids in one pass. `movedKeys` records the line keys that
 * belonged to each source channel so merge records can still be undone.
 */
export function remapLineChannels<T extends LineChannelLike>(lines: T[], fromTo: Map<string, string>): LineRemapResult {
  const movedKeys = new Map<string, string[]>();
  let changed = 0;
  for (const line of lines) {
    const from = line.channelId;
    const to = from ? fromTo.get(from) : undefined;
    if (!from || !to) continue;
    if (!movedKeys.has(from)) movedKeys.set(from, []);
    if (line.key) movedKeys.get(from)!.push(line.key);
    line.channelId = to;
    changed++;
  }
  return { changed, movedKeys };
}

export { normalizeChannelName };
