import { describe, expect, it } from 'vitest';
import { buildM3U, buildTXT, buildJSON, buildDIYP, toExportChannels } from '../src/export/index.js';
import type { ExportChannel } from '../src/export/types.js';

const channels: ExportChannel[] = [
  {
    id: 'cctv1',
    name: 'CCTV-1 综合',
    group: '央视',
    tvgId: 'CCTV1',
    logo: 'https://logo/1.png',
    number: 1,
    lines: [
      { url: 'http://a/1.m3u8', region: '江苏', operator: '电信', catchup: 'append', catchupSource: '?start=${start}', catchupDays: 7, headers: { userAgent: 'VLC/3.0' } },
      { url: 'http://b/1.m3u8', resolution: '1080p', speedKbps: 2400 },
    ],
  },
  {
    id: 'hunan',
    name: '湖南卫视',
    group: '卫视',
    tvgId: '湖南卫视',
    lines: [{ url: 'http://c/hunan.m3u8' }],
  },
];

describe('M3U export', () => {
  it('writes tvg attributes, catch-up and request headers', () => {
    const text = buildM3U(channels, { epgUrl: 'https://epg/e.xml' });
    expect(text.startsWith('#EXTM3U url-tvg="https://epg/e.xml"')).toBe(true);
    expect(text).toContain('tvg-id="cctv1"');
    expect(text).toContain('group-title="央视"');
    expect(text).toContain('#EXTGRP:央视');
    expect(text).toContain('catchup="append"');
    expect(text).toContain('catchup-days="7"');
    expect(text).toContain('#EXTVLCOPT:http-user-agent=VLC/3.0');
    expect(text.match(/,CCTV-1 综合/g)).toHaveLength(2);
    expect(text).not.toContain('（-江苏电信）');
    expect(text).toContain('http://a/1.m3u8');
  });

  it('keeps the display name identical for every line of a channel', () => {
    const text = buildM3U(channels, { showRegionSuffix: true });
    expect(text.match(/,CCTV-1 综合/g)).toHaveLength(2);
    expect(text).not.toContain('（-江苏电信）');
  });
});

describe('TXT export', () => {
  it('emits genre headers once per group', () => {
    const text = buildTXT(channels);
    expect(text).toContain('央视,#genre#');
    expect(text).toContain('卫视,#genre#');
    expect(text.split('央视,#genre#')).toHaveLength(2);
    expect(text).toContain('CCTV-1 综合,http://a/1.m3u8');
  });
});

describe('JSON exports', () => {
  it('produces a flat array', () => {
    const rows = JSON.parse(buildJSON(channels)) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    expect(rows[0]!['group']).toBe('央视');
    expect(rows[0]!['tvg_id']).toBe('CCTV1');
  });

  it('produces DIYP lives structure', () => {
    const parsed = JSON.parse(buildDIYP(channels)) as { lives: Array<{ group: string; channels: Array<{ name: string; urls: string[] }> }> };
    expect(parsed.lives[0]!.group).toBe('央视');
    expect(parsed.lives[0]!.channels[0]!.urls).toHaveLength(2);
  });
});

describe('toExportChannels', () => {
  it('builds logo from tvg-id when missing', () => {
    const [channel] = toExportChannels(
      [{ channel: { id: 'cctv1', name: 'CCTV1', group: '央视', tvgId: 'CCTV1', aliases: [] }, lines: [] }],
      { logoBaseUrl: 'https://logo/' },
    );
    expect(channel?.logo).toBe('https://logo/CCTV1.png');
  });
});
