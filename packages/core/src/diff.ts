import type { CatalogDiff, LineEntry } from './types.js';

export interface SnapshotChannel {
  channel: { id: string; name: string; group: string };
  lines: LineEntry[];
}

export interface DiffSnapshot {
  generatedAt: string;
  channels: SnapshotChannel[];
}

/** Compare two daily catalogs; drives alerts and the "what changed" view. */
export function diffCatalogs(previous: DiffSnapshot | null, current: DiffSnapshot): CatalogDiff {
  const before = new Map<string, SnapshotChannel>();
  const after = new Map<string, SnapshotChannel>();
  for (const item of previous?.channels ?? []) before.set(item.channel.id, item);
  for (const item of current.channels) after.set(item.channel.id, item);

  const addedChannels: CatalogDiff['addedChannels'] = [];
  for (const [id, item] of after) {
    if (!before.has(id)) addedChannels.push({ id, name: item.channel.name, group: item.channel.group });
  }
  const removedChannels: CatalogDiff['removedChannels'] = [];
  for (const [id, item] of before) {
    if (!after.has(id)) removedChannels.push({ id, name: item.channel.name, group: item.channel.group });
  }

  const countLines = (items: Iterable<SnapshotChannel>): number => {
    let total = 0;
    for (const item of items) total += item.lines.length;
    return total;
  };
  const countAlive = (items: Iterable<SnapshotChannel>): number => {
    let total = 0;
    for (const item of items) total += item.lines.filter((line) => line.status === 'alive').length;
    return total;
  };

  const beforeGroups = groupCounts(before.values());
  const afterGroups = groupCounts(after.values());
  const groups = [...new Set([...beforeGroups.keys(), ...afterGroups.keys()])]
    .map((group) => ({ group, before: beforeGroups.get(group) ?? 0, after: afterGroups.get(group) ?? 0 }))
    .filter((entry) => entry.before !== entry.after)
    .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before));

  const beforeSource = aliveBySource(before.values());
  const afterSource = aliveBySource(after.values());
  const deadSurge: CatalogDiff['deadSurge'] = [];
  for (const [sourceId, beforeAlive] of beforeSource) {
    const nowAlive = afterSource.get(sourceId) ?? 0;
    if (beforeAlive >= 5 && nowAlive < beforeAlive * 0.6 && beforeAlive - nowAlive >= 3) {
      deadSurge.push({ sourceId, dead: beforeAlive - nowAlive });
    }
  }
  deadSurge.sort((a, b) => b.dead - a.dead);

  return {
    previousAt: previous?.generatedAt ?? null,
    currentAt: current.generatedAt,
    channelsBefore: before.size,
    channelsAfter: after.size,
    linesBefore: countLines(before.values()),
    linesAfter: countLines(after.values()),
    aliveBefore: countAlive(before.values()),
    aliveAfter: countAlive(after.values()),
    addedChannels: addedChannels.slice(0, 50),
    removedChannels: removedChannels.slice(0, 50),
    deadSurge: deadSurge.slice(0, 10),
    groups: groups.slice(0, 20),
  };
}

function groupCounts(items: Iterable<SnapshotChannel>): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) map.set(item.channel.group, (map.get(item.channel.group) ?? 0) + 1);
  return map;
}

function aliveBySource(items: Iterable<SnapshotChannel>): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    for (const line of item.lines) {
      if (line.status !== 'alive') continue;
      map.set(line.sourceId, (map.get(line.sourceId) ?? 0) + 1);
    }
  }
  return map;
}

/** Telegram-friendly summary (Markdown). */
export function formatDiff(diff: CatalogDiff): string {
  const lines: string[] = [];
  const sign = (value: number): string => (value > 0 ? `+${value}` : String(value));
  lines.push(`📺 IPTV 日报 ${diff.currentAt.slice(0, 10)}`);
  lines.push(`频道 ${diff.channelsBefore} → ${diff.channelsAfter} (${sign(diff.channelsAfter - diff.channelsBefore)})`);
  lines.push(`发布线路 ${diff.linesBefore} → ${diff.linesAfter}，可用 ${diff.aliveBefore} → ${diff.aliveAfter} (${sign(diff.aliveAfter - diff.aliveBefore)})`);
  lines.push(`数据截至 ${diff.currentAt.replace('T', ' ').slice(0, 16)} UTC`);

  if (diff.addedChannels.length) {
    lines.push(`\n新增频道：${diff.addedChannels.slice(0, 8).map((item) => item.name).join('、')}`);
  }
  if (diff.removedChannels.length) {
    lines.push(`\n消失频道：${diff.removedChannels.slice(0, 8).map((item) => item.name).join('、')}`);
  }
  for (const item of diff.groups.slice(0, 5)) {
    lines.push(`· ${item.group}: ${item.before} → ${item.after}`);
  }
  if (diff.deadSurge.length) {
    lines.push(`\n⚠️ 异常失效率：${diff.deadSurge.map((item) => `${item.sourceId} -${item.dead}`).join('，')}`);
  }
  return lines.join('\n');
}
