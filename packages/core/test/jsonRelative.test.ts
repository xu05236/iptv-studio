import { describe, expect, it } from 'vitest';
import { parseSource } from '../src/parse/index.js';

const sample = JSON.stringify({
  code: 0,
  msg: 1794209800,
  count: 2,
  data: [
    { type: 2, typename: '央视', name: 'CCTV1-综合', url: '/tsfile/live/0001_1.m3u8?key=txiptv&playlive=1&authid=0' },
    { type: 2, typename: '央视', name: 'CCTV2-财经', url: '/tsfile/live/0002_1.m3u8?key=txiptv' },
  ],
});

describe('relative JSON sources', () => {
  it('resolves portal paths against the source URL', () => {
    const parsed = parseSource(sample, 'auto', { baseUrl: 'http://221.224.4.170:1111/iptv/live/1000.json?key=txiptv' });
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].url).toBe('http://221.224.4.170:1111/tsfile/live/0001_1.m3u8?key=txiptv&playlive=1&authid=0');
  });

  it('uses typename as the group instead of numeric type', () => {
    const parsed = parseSource(sample, 'auto');
    expect(parsed.entries[0].group).toBe('央视');
  });

  it('still parses absolute URLs unchanged', () => {
    const absolute = JSON.stringify({ data: [{ name: 'CCTV1', url: 'http://example.com/live.m3u8' }] });
    const parsed = parseSource(absolute, 'auto', { baseUrl: 'http://portal.example/api.json' });
    expect(parsed.entries[0].url).toBe('http://example.com/live.m3u8');
  });
});
