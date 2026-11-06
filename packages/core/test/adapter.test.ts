import { describe, expect, it } from 'vitest';
import { parseSource } from '../src/parse/index.js';
import { getSourceAdapter, listSourceAdapters, parseWithAdapter, registerSourceAdapter } from '../src/source/adapter.js';

const samples: Record<string, string> = {
  m3u: '#EXTM3U\n#EXTINF:-1 tvg-id="CCTV1" group-title="央视",CCTV-1\nhttp://a/1.m3u8\n',
  txt: '央视,#genre#\nCCTV-1 综合,http://a/1.m3u8\nCCTV-2 财经,http://b/2.m3u8\n',
  json: JSON.stringify({ lives: [{ group: '央视', channels: [{ name: 'CCTV1', urls: ['http://a/1.m3u8', 'http://a/1b.m3u8'] }] }] }),
  hwctc: 'Authorization: Bearer demo\n央视,#genre#\nCCTV-1,http://a/1.m3u8\n',
};

describe('source adapter registry', () => {
  it('keeps legacy parse results identical for every explicit format', () => {
    for (const [hint, text] of Object.entries(samples)) {
      expect(parseWithAdapter(text, hint)).toEqual(parseSource(text, hint as never));
    }
    expect(parseWithAdapter(samples.json!, 'tvbox')).toEqual(parseSource(samples.json!, 'tvbox'));
  });

  it('falls back to the same auto detection as before', () => {
    for (const text of Object.values(samples)) {
      expect(parseWithAdapter(text, 'auto')).toEqual(parseSource(text, 'auto'));
    }
  });

  it('registers built-ins and accepts a custom site adapter', () => {
    const ids = listSourceAdapters().map((adapter) => adapter.id);
    expect(ids).toEqual(expect.arrayContaining(['m3u', 'txt', 'json', 'hwctc', 'auto']));
    registerSourceAdapter({
      id: 'site-json',
      label: '站点 JSON',
      detect: (text) => (text.includes('"streams"') ? 0.9 : 0),
      parse: () => ({ kind: 'json', entries: [], epgUrls: [], warnings: [] }),
      validate: () => [],
    });
    expect(getSourceAdapter('site-json')?.label).toBe('站点 JSON');
    expect(getSourceAdapter('tvbox')?.id).toBe('json');
  });
});
