import { describe, expect, it } from 'vitest';
import { parseDiypProgrammes } from '../src/pipeline/epg.js';

describe('parseDiypProgrammes', () => {
  it('parses the common data array shape with local timestamps', () => {
    const items = parseDiypProgrammes(
      {
        code: 200,
        data: [
          { title: '新闻联播', start_time: '2026-11-26 19:00:00', end_time: '2026-11-26 19:30:00' },
          { name: '焦点访谈', start: '2026-11-26 19:38:00', end: '2026-11-26 20:00:00' },
        ],
      },
      'cctv1',
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ channelId: 'cctv1', title: '新闻联播' });
    expect(new Date(items[0].start).toISOString()).toBe('2026-11-26T11:00:00.000Z');
  });

  it('accepts programs/epg keys and epoch seconds', () => {
    const items = parseDiypProgrammes(
      { data: { programs: [{ programName: '电视剧', start: 1_764_000_000, end: 1_764_003_600 }] } },
      'x-demo',
    );
    expect(items).toHaveLength(1);
    expect(items[0].start).toBe(1_764_000_000_000);
  });

  it('ignores malformed entries instead of throwing', () => {
    expect(parseDiypProgrammes({ data: [null, {}, { title: '无时间' }, { start: 'bad' }] }, 'x')).toEqual([]);
    expect(parseDiypProgrammes(null, 'x')).toEqual([]);
    expect(parseDiypProgrammes('oops', 'x')).toEqual([]);
  });
});
