import type { LineEntry } from '../types.js';
import { normalizeUrlForDedupe } from '../util/url.js';

export interface SourceOverlapItem {
  sourceId: string;
  total: number;
  duplicated: number;
  unique: number;
  earliestWins: number;
  share: number;
}

export interface SourceOverlapReport {
  generatedAt: string;
  totalLines: number;
  uniqueUrls: number;
  duplicateUrls: number;
  duplicatedLines: number;
  items: SourceOverlapItem[];
}

/**
 * Cross-source overlap statistics. Computed at publish time because doing it
 * per request means parsing the whole line state inside the Worker, which
 * blows the CPU budget and intermittently returns 503.
 */
export function computeSourceOverlap(lines: LineEntry[], generatedAt: string): SourceOverlapReport {
  const byUrl = new Map<string, { sources: Set<string>; first: Map<string, string>; lines: number }>();
  const perSource = new Map<string, { total: number; urls: Set<string> }>();
  for (const line of lines) {
    if (!line.url) continue;
    const url = normalizeUrlForDedupe(line.url) || line.url;
    const group = byUrl.get(url) ?? { sources: new Set<string>(), first: new Map<string, string>(), lines: 0 };
    group.sources.add(line.sourceId);
    group.lines += 1;
    const seen = group.first.get(line.sourceId);
    if (!seen || line.firstSeenAt < seen) group.first.set(line.sourceId, line.firstSeenAt);
    byUrl.set(url, group);
    const stat = perSource.get(line.sourceId) ?? { total: 0, urls: new Set<string>() };
    stat.total += 1;
    stat.urls.add(url);
    perSource.set(line.sourceId, stat);
  }

  const dupBySource = new Map<string, { duplicated: number; earliestWins: number }>();
  let duplicateUrls = 0;
  let duplicatedLines = 0;
  for (const group of byUrl.values()) {
    if (group.sources.size < 2) continue;
    duplicateUrls += 1;
    duplicatedLines += group.lines;
    let earliestId: string | null = null;
    let earliestAt = '';
    for (const [id, at] of group.first) {
      if (!earliestId || at < earliestAt) {
        earliestId = id;
        earliestAt = at;
      }
    }
    for (const id of group.sources) {
      const stat = dupBySource.get(id) ?? { duplicated: 0, earliestWins: 0 };
      stat.duplicated += 1;
      if (id === earliestId) stat.earliestWins += 1;
      dupBySource.set(id, stat);
    }
  }

  const items: SourceOverlapItem[] = [];
  for (const [sourceId, stats] of perSource) {
    const dup = dupBySource.get(sourceId);
    const duplicated = dup?.duplicated ?? 0;
    items.push({
      sourceId,
      total: stats.total,
      duplicated,
      unique: Math.max(0, stats.urls.size - duplicated),
      earliestWins: dup?.earliestWins ?? 0,
      share: stats.total ? duplicated / stats.total : 0,
    });
  }
  items.sort((a, b) => b.duplicated - a.duplicated || b.unique - a.unique);

  return {
    generatedAt,
    totalLines: lines.length,
    uniqueUrls: byUrl.size,
    duplicateUrls,
    duplicatedLines,
    items,
  };
}
