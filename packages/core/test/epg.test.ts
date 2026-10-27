import { describe, expect, it } from 'vitest';
import { buildXmltv, formatXmltvDate, parseXmltv, parseXmltvDate } from '../src/epg/xmltv.js';
import { mergeEpg } from '../src/epg/merge.js';

const sample = `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="test">
  <channel id="CCTV1"><display-name>CCTV-1</display-name><icon src="http://logo/1.png"/></channel>
  <channel id="湖南卫视"><display-name>湖南卫视</display-name></channel>
  <programme start="20261027120000 +0800" stop="20261027130000 +0800" channel="CCTV1">
    <title lang="zh">新闻30分</title>
    <desc lang="zh">午间新闻</desc>
    <category>新闻</category>
  </programme>
  <programme start="20261027130000 +0800" stop="20261027140000 +0800" channel="CCTV1">
    <title>今日说法</title>
  </programme>
  <programme start="20261027120000 +0800" stop="20261027140000 +0800" channel="湖南卫视">
    <title>综艺</title>
  </programme>
</tv>`;

describe('XMLTV parsing', () => {
  it('parses channels and programmes with timezone offsets', () => {
    const data = parseXmltv(sample);
    expect(data.channels).toHaveLength(2);
    expect(data.programmes).toHaveLength(3);
    expect(data.programmes[0]!.title).toBe('新闻30分');
    expect(data.programmes[0]!.start).toBe(Date.UTC(2026, 9, 27, 4, 0, 0));
    expect(data.channels[0]!.icon).toBe('http://logo/1.png');
  });

  it('round-trips dates', () => {
    const epoch = Date.UTC(2026, 9, 27, 4, 0, 0);
    expect(formatXmltvDate(epoch, 480)).toBe('20261027120000 +0800');
    expect(parseXmltvDate('20261027120000 +0800')).toBe(epoch);
  });
});

describe('merge', () => {
  it('dedupes identical programmes and keeps the richer one', () => {
    const first = parseXmltv(sample);
    const second = parseXmltv(sample.replace('<desc lang="zh">午间新闻</desc>', ''));
    const merged = mergeEpg([first, second], { now: new Date('2026-10-27T04:00:00Z'), days: 7 });
    expect(merged.programmes.filter((item) => item.title === '新闻30分')).toHaveLength(1);
    expect(merged.programmes.find((item) => item.title === '新闻30分')?.desc).toBe('午间新闻');
  });

  it('serialises a valid guide', () => {
    const data = parseXmltv(sample);
    const xml = buildXmltv(data, { channelNames: new Map([['CCTV1', 'CCTV-1 综合']]) });
    expect(xml).toContain('<display-name>CCTV-1 综合</display-name>');
    expect(xml).toContain('start="20261027120000 +0800"');
    expect(xml).toContain('<title lang="zh">新闻30分</title>');
    expect(parseXmltv(xml).programmes).toHaveLength(3);
  });
});
