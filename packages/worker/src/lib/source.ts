import { tierFor } from '@iptv/core';
import type { SourceRow } from '../db.js';

export interface SourceMeta {
  name: string;
  site: string;
  reputation: number;
  tier: 'high' | 'normal' | 'low';
}

/** Human readable origin for a source row: hostname or upload/paste label. */
export function sourceSite(source: Pick<SourceRow, 'url' | 'origin'> | undefined): string {
  if (!source) return '未知来源';
  if (source.url) {
    try {
      return new URL(source.url).hostname;
    } catch {
      return '远程源';
    }
  }
  return source.origin === 'upload' ? '本地上传' : '手动粘贴';
}

export function sourceMetaMap(rows: SourceRow[]): Map<string, SourceMeta> {
  return new Map(rows.map((row) => {
    const reputation = Number(row.reputation ?? 50);
    return [row.id, { name: row.name, site: sourceSite(row), reputation, tier: tierFor(reputation) }];
  }));
}
