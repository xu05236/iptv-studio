/**
 * One-off generator: match public iptv-org/database rows (Unlicense) against
 * our built-in channel seeds and emit extra aliases for human review.
 *
 * Usage:
 *   npx tsx scripts/generate-alias-candidates.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeChannelName } from '../packages/core/src/util/text.js';

interface Builtin {
  id: string;
  name: string;
  tvgId: string;
  aliases: string[];
}

interface Row {
  id: string;
  name: string;
  alt_names: string;
  country: string;
}

const GENERIC = new Set([
  'tv', 'cctv', 'china', 'chinese', 'hd', 'uhd', '4k', '8k', 'sd',
  '综合', '频道', '卫视', '电视台', '电视', '国际', '新闻', '体育', '电影',
  '影视', '少儿', '音乐', '地方', '港澳台', '央视', '中国', '台',
]);

const builtins = JSON.parse(readFileSync('builtins.json', 'utf8')) as Builtin[];
const rows = JSON.parse(readFileSync('cn-channels.json', 'utf8')) as Row[];

const byKey = new Map<string, Builtin>();
const canonical = new Map<string, string>();
for (const channel of builtins) {
  for (const value of [channel.name, channel.tvgId, ...channel.aliases]) {
    const key = normalizeChannelName(value);
    if (key) byKey.set(key, channel);
    if (!canonical.has(key)) canonical.set(key, channel.id);
  }
}

const ids = new Map(builtins.map((channel) => [channel.tvgId.toLowerCase(), channel]));
for (const channel of builtins) ids.set(channel.id.replace(/-/g, '').toLowerCase(), channel);

const extra = new Map<string, Set<string>>();
let matched = 0;
for (const row of rows) {
  const baseId = row.id.split('.')[0]!.toLowerCase();
  const names = [row.name, ...row.alt_names.split(';')].map((value) => value.trim()).filter(Boolean);
  const channel = ids.get(baseId) ?? names.map((name) => byKey.get(normalizeChannelName(name))).find(Boolean);
  if (!channel) continue;
  matched++;
  const current = extra.get(channel.id) ?? new Set<string>();
  for (const name of names) {
    const key = normalizeChannelName(name);
    if (!key || key.length < 2 || GENERIC.has(name.toLowerCase()) || GENERIC.has(key)) continue;
    const owner = canonical.get(key);
    if (owner && owner !== channel.id) continue;
    if ([channel.name, channel.tvgId, ...channel.aliases].some((value) => normalizeChannelName(value) === key)) continue;
    current.add(name);
  }
  extra.set(channel.id, current);
}

const result: Record<string, string[]> = {};
for (const channel of builtins) {
  const values = [...(extra.get(channel.id) ?? [])].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  if (values.length) result[channel.id] = values;
}

const total = Object.values(result).reduce((sum, values) => sum + values.length, 0);
const body = `// Generated from iptv-org/database (Unlicense) by
// scripts/generate-alias-candidates.ts. Review before adding new rows.
export const EXTRA_ALIASES: Record<string, string[]> = ${JSON.stringify(result, null, 2)};
`;
writeFileSync('packages/core/src/normalize/extraAliases.ts', body);
console.log(JSON.stringify({ rows: rows.length, matched, channels: Object.keys(result).length, aliases: total }, null, 2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(result).slice(0, 5)), null, 2));
