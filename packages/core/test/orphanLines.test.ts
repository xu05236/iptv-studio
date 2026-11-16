import { describe, expect, it } from 'vitest';
import type { LineEntry } from '../src/types.js';
import { pruneOrphanLines } from '../src/state/orphans.js';

function line(partial: Partial<LineEntry> & { key: string; channelId: string; sourceId: string }): LineEntry {
  return { name: 'test', url: 'http://example/live.m3u8', status: 'unknown', ...partial } as LineEntry;
}

describe('pruneOrphanLines', () => {
  it('keeps lines whose channel and source still exist', () => {
    const result = pruneOrphanLines({ channelIds: ['c1'], sourceIds: ['s1'] }, [line({ key: 'k1', channelId: 'c1', sourceId: 's1' })]);
    expect(result).toMatchObject({ removed: 0, missingChannel: 0, missingSource: 0, keptAlive: 0 });
  });

  it('drops non-alive lines when the source was deleted', () => {
    const result = pruneOrphanLines({ channelIds: ['c1'], sourceIds: [] }, [line({ key: 'k1', channelId: 'c1', sourceId: 's1' })]);
    expect(result).toMatchObject({ removed: 1, missingChannel: 0, missingSource: 1, keptAlive: 0 });
    expect(result.lines).toHaveLength(0);
  });

  it('keeps usable lines from a deleted source', () => {
    const result = pruneOrphanLines({ channelIds: ['c1'], sourceIds: [] }, [line({ key: 'k1', channelId: 'c1', sourceId: 's1', status: 'alive' })]);
    expect(result).toMatchObject({ removed: 0, missingSource: 0, keptAlive: 1 });
    expect(result.lines).toHaveLength(1);
  });

  it('drops non-alive lines with a missing channel but keeps x- channels', () => {
    const result = pruneOrphanLines(
      { channelIds: [], sourceIds: ['s1'] },
      [
        line({ key: 'k1', channelId: 'gone', sourceId: 's1' }),
        line({ key: 'k2', channelId: 'x-new', sourceId: 's1' }),
      ],
    );
    expect(result).toMatchObject({ removed: 1, missingChannel: 1, keptAlive: 0 });
    expect(result.lines.map((item) => item.key)).toEqual(['k2']);
  });

  it('keeps alive lines even when both references are gone', () => {
    const result = pruneOrphanLines({ channelIds: [], sourceIds: [] }, [line({ key: 'k1', channelId: 'gone', sourceId: 's1', status: 'alive' })]);
    expect(result).toMatchObject({ removed: 0, keptAlive: 1 });
  });
});
