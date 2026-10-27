import type { ExportChannel, PlaylistOptions } from './types.js';
import { lineDisplayName } from './types.js';

/** DIYP / TVBox classic TXT: `分组,#genre#` followed by `频道名,地址`. */
export function buildTXT(channels: ExportChannel[], options: PlaylistOptions = {}): string {
  const groups = new Map<string, string[]>();
  for (const channel of channels) {
    const bucket = groups.get(channel.group) ?? [];
    for (const line of channel.lines) {
      if (!line.url) continue;
      bucket.push(`${lineDisplayName(channel, line, options)},${line.url.trim()}`);
    }
    groups.set(channel.group, bucket);
  }

  const out: string[] = [];
  for (const [group, rows] of groups) {
    if (!rows.length) continue;
    out.push(`${group},#genre#`);
    out.push(...rows);
  }
  return `${out.join('\n')}\n`;
}

/** Plain JSON array, understood by most modern players and easy to post-process. */
export function buildJSON(channels: ExportChannel[], options: PlaylistOptions = {}): string {
  const rows: Array<Record<string, unknown>> = [];
  for (const channel of channels) {
    for (const line of channel.lines) {
      if (!line.url) continue;
      const row: Record<string, unknown> = {
        name: channel.name,
        url: line.url.trim(),
        group: channel.group,
      };
      if (channel.tvgId) row.tvg_id = channel.tvgId;
      if (channel.logo) row.logo = channel.logo;
      const display = lineDisplayName(channel, line, options);
      if (display !== channel.name) row.display_name = display;
      if (line.headers && Object.keys(line.headers).length) row.headers = line.headers;
      if (line.catchup) row.catchup = line.catchup;
      if (line.catchupSource) row.catchup_source = line.catchupSource;
      if (line.catchupDays) row.catchup_days = line.catchupDays;
      rows.push(row);
    }
  }
  return `${JSON.stringify(rows, null, 2)}\n`;
}

/** DIYP `lives` structure: groups -> channels -> urls (multi-line friendly). */
export function buildDIYP(channels: ExportChannel[], options: PlaylistOptions = {}): string {
  const groups = new Map<string, Map<string, string[]>>();
  for (const channel of channels) {
    const group = groups.get(channel.group) ?? new Map<string, string[]>();
    const key = channel.name;
    const urls = group.get(key) ?? [];
    for (const line of channel.lines) if (line.url) urls.push(line.url.trim());
    if (urls.length) group.set(key, urls);
    groups.set(channel.group, group);
  }

  const lives = [...groups.entries()]
    .filter(([, group]) => group.size > 0)
    .map(([group, entries]) => ({
      group,
      channels: [...entries.entries()].map(([name, urls]) => ({ name, urls })),
    }));

  // `options` is accepted for signature parity; region suffix is not part of DIYP names.
  void options;
  return `${JSON.stringify({ lives }, null, 2)}\n`;
}
