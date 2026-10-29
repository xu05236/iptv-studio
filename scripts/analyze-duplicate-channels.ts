/**
 * Compare generated x- channels with the built-in channel/alias library and
 * emit a review report. Nothing is merged automatically.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { BUILTIN_CHANNELS, type ChannelSeed } from '../packages/core/src/normalize/channels.js';
import { diceCoefficient, normalizeChannelName } from '../packages/core/src/util/text.js';

interface DbChannel {
  id: string;
  name: string;
  group_title?: string | null;
  enabled?: number | boolean;
}

interface Candidate {
  xId: string;
  xName: string;
  group: string;
  builtinId: string;
  builtinName: string;
  score: number;
  kind: 'exact' | 'alias' | 'fuzzy';
  matchedAlias?: string;
}

const channels = JSON.parse(readFileSync('d1-channels.json', 'utf8')).items as DbChannel[];
const xChannels = channels.filter((channel) => channel.id.startsWith('x-'));
const exact = new Map<string, ChannelSeed>();
const aliases: Array<{ key: string; channel: ChannelSeed; alias: string }> = [];

for (const channel of BUILTIN_CHANNELS) {
  exact.set(normalizeChannelName(channel.name), channel);
  for (const alias of [channel.name, channel.tvgId, ...(channel.aliases ?? [])]) {
    const key = normalizeChannelName(alias);
    if (key) aliases.push({ key, channel, alias });
  }
}

const candidates: Candidate[] = [];
for (const item of xChannels) {
  const key = normalizeChannelName(item.name);
  if (!key || key.length < 2) continue;
  const exactMatch = exact.get(key);
  if (exactMatch) {
    candidates.push({
      xId: item.id,
      xName: item.name,
      group: item.group_title ?? '',
      builtinId: exactMatch.id,
      builtinName: exactMatch.name,
      score: 1,
      kind: 'exact',
    });
    continue;
  }

  let best: { channel: ChannelSeed; score: number; alias: string } | null = null;
  for (const entry of aliases) {
    if (entry.key.length < 2) continue;
    const score = diceCoefficient(key, entry.key);
    if (!best || score > best.score) best = { channel: entry.channel, score, alias: entry.alias };
  }
  if (best && best.score >= 0.78) {
    candidates.push({
      xId: item.id,
      xName: item.name,
      group: item.group_title ?? '',
      builtinId: best.channel.id,
      builtinName: best.channel.name,
      score: Number(best.score.toFixed(3)),
      kind: best.score >= 0.98 ? 'alias' : 'fuzzy',
      matchedAlias: best.alias,
    });
  }
}

candidates.sort((a, b) => b.score - a.score);
const lines = [
  '# x- 频道与内置频道合并候选',
  '',
  `生成时间：${new Date().toISOString()}`,
  `x- 频道：${xChannels.length}，候选：${candidates.length}（score ≥ 0.78）`,
  '',
  '| x- ID | 现有名称 | 分组 | 建议合并到 | 匹配别名 | 分数 | 类型 |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...candidates.slice(0, 100).map((item) =>
    `| ${item.xId} | ${item.xName} | ${item.group} | ${item.builtinName} (${item.builtinId}) | ${item.matchedAlias ?? ''} | ${item.score} | ${item.kind} |`,
  ),
];
writeFileSync('docs/ALIAS-CANDIDATES.md', `${lines.join('\n')}\n`);
writeFileSync('alias-candidates.json', JSON.stringify(candidates, null, 2));
console.log(JSON.stringify({ xChannels: xChannels.length, candidates: candidates.length, exact: candidates.filter((item) => item.kind === 'exact').length, top: candidates.slice(0, 15) }, null, 2));
