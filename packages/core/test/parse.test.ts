import { describe, expect, it } from 'vitest';
import { detectSourceKind, parseSource } from '../src/parse/index.js';
import { parseM3U } from '../src/parse/m3u.js';
import { parseTXT } from '../src/parse/txt.js';

describe('M3U parser', () => {
  const sample = `\uFEFF#EXTM3U x-tvg-url="https://epg.example/e.xml,https://epg.example/2.xml"
#EXTINF:-1 tvg-id="CCTV1" tvg-name="CCTV-1" tvg-logo="http://logo/1.png" group-title="央视",CCTV-1 综合
#EXTVLCOPT:http-user-agent=Mozilla/5.0 Test
#EXTVLCOPT:http-referrer=http://ref.example/
http://a.example/live/cctv1.m3u8
#EXTINF:-1 tvg-id="CCTV2" group-title="央视",CCTV-2 财经, 高清
http://b.example/live/cctv2.m3u8|User-Agent=Suffix-UA&Referer=http://suffix.example/
#EXTGRP:卫视
#EXTINF:-1,Hunan TV
http://c.example/live/hunan.m3u8
`;

  it('parses attributes, headers, groups and multiple epg urls', () => {
    const parsed = parseM3U(sample);
    expect(parsed.entries).toHaveLength(3);
    expect(parsed.epgUrls).toEqual(['https://epg.example/e.xml', 'https://epg.example/2.xml']);
    expect(parsed.entries[0]!.name).toBe('CCTV-1 综合');
    expect(parsed.entries[0]!.headers?.userAgent).toBe('Mozilla/5.0 Test');
    expect(parsed.entries[1]!.name).toBe('CCTV-2 财经, 高清');
    expect(parsed.entries[1]!.headers?.userAgent).toBe('Suffix-UA');
    expect(parsed.entries[2]!.group).toBe('卫视');
  });

  it('keeps catch-up attributes', () => {
    const parsed = parseM3U('#EXTM3U\n#EXTINF:-1 tvg-id="CCTV1" catchup="append" catchup-source="?start=${start}" catchup-days="7",CCTV1\nhttp://x/1.m3u8\n');
    expect(parsed.entries[0]!.catchup).toBe('append');
    expect(parsed.entries[0]!.catchupDays).toBe(7);
  });
});

describe('TXT parser', () => {
  it('handles groups, multi url rows and full width commas', () => {
    const text = `央视,#genre#
CCTV-1 综合,http://a/1.m3u8
CCTV-2 财经，http://b/2.m3u8#http://b/2-backup.m3u8
卫视,#genre#
湖南卫视|http://c/hunan.m3u8
`;
    const parsed = parseTXT(text);
    expect(parsed.entries).toHaveLength(4);
    expect(parsed.entries[0]!.group).toBe('央视');
    expect(parsed.entries[1]!.url).toBe('http://b/2.m3u8');
    expect(parsed.entries[2]!.url).toBe('http://b/2-backup.m3u8');
    expect(parsed.entries[3]!.group).toBe('卫视');
  });
});

describe('JSON parser', () => {
  it('parses DIYP lives payloads', () => {
    const text = JSON.stringify({
      lives: [
        { group: '央视', channels: [{ name: 'CCTV1', urls: ['http://a/1.m3u8', 'http://a/1b.m3u8'] }] },
      ],
    });
    const parsed = parseSource(text);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]!.group).toBe('央视');
  });

  it('parses plain arrays with tvg metadata', () => {
    const text = JSON.stringify([{ name: 'CCTV-1', url: 'http://a/1.m3u8', group: '央视', logo: 'http://l/1.png', tvg_id: 'CCTV1' }]);
    const parsed = parseSource(text);
    expect(parsed.entries[0]!.tvgId).toBe('CCTV1');
    expect(parsed.entries[0]!.logo).toBe('http://l/1.png');
  });
});

describe('format detection', () => {
  it('detects m3u, txt and json', () => {
    expect(detectSourceKind('#EXTM3U\n#EXTINF:-1,A\nhttp://a')).toBe('m3u');
    expect(detectSourceKind('央视,#genre#\nCCTV1,http://a')).toBe('txt');
    expect(detectSourceKind('[{"name":"a","url":"http://a"}]')).toBe('json');
  });
});
