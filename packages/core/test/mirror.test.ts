import { describe, expect, it } from 'vitest';
import { MAX_MIRROR_URLS, normalizeMirrorUrls } from '../src/source/mirrors.js';

describe('normalizeMirrorUrls', () => {
  it('accepts arrays and JSON strings, trims and dedupes', () => {
    expect(normalizeMirrorUrls([' https://a.example/1.m3u ', 'https://a.example/1.m3u', 'http://b.example/2.m3u']).urls).toEqual([
      'https://a.example/1.m3u',
      'http://b.example/2.m3u',
    ]);
    expect(normalizeMirrorUrls('["https://a.example/1.m3u"]').urls).toEqual(['https://a.example/1.m3u']);
    expect(normalizeMirrorUrls('https://a.example/1.m3u\nhttps://b.example/2.m3u').urls).toHaveLength(2);
  });

  it('rejects unusable entries', () => {
    expect(normalizeMirrorUrls(['ftp://a.example/1.m3u']).error).toContain('http(s)');
    expect(normalizeMirrorUrls(['not a url']).error).toContain('不合法');
    expect(normalizeMirrorUrls([1]).error).toContain('字符串');
  });

  it('caps the number of mirrors', () => {
    const urls = Array.from({ length: MAX_MIRROR_URLS + 1 }, (_, index) => `https://a.example/${index}.m3u`);
    expect(normalizeMirrorUrls(urls).error).toContain(String(MAX_MIRROR_URLS));
  });
});
