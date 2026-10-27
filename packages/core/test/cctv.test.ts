import { describe, expect, it } from 'vitest';
import { cctvApiCode, cleanCctvTitle, parseCctvEpg } from '../src/epg/cctv.js';

const payload = {
  cctv1: {
    channelName: 'CCTV-1 综合',
    program: [
      { t: '新闻30分-2026-193', st: 1793031125, et: 1793032980, showTime: '00:12' },
      { t: '今日说法-2026-193', st: 1793032980, et: 1793035200 },
      { t: '', st: 1793035200, et: 1793038800 },
    ],
  },
};

describe('CNTV EPG parser', () => {
  it('extracts programmes and converts seconds to ms', () => {
    const parsed = parseCctvEpg(payload, 'cctv1');
    expect(parsed).not.toBeNull();
    expect(parsed!.channel.names[0]).toBe('CCTV-1 综合');
    expect(parsed!.programmes).toHaveLength(2);
    expect(parsed!.programmes[0]!.start).toBe(1793031125000);
    expect(parsed!.programmes[0]!.title).toBe('新闻30分');
  });

  it('cleans episode suffixes', () => {
    expect(cleanCctvTitle('国际足球赛场-26-27赛季 曼城—伯恩茅斯（4K）')).toBe('国际足球赛场-26-27赛季 曼城—伯恩茅斯（4K）');
    expect(cleanCctvTitle('今日说法-2026-193')).toBe('今日说法');
  });

  it('maps only supported channel ids', () => {
    expect(cctvApiCode('cctv1')).toBe('cctv1');
    expect(cctvApiCode('cctv5plus')).toBe('cctv5plus');
    expect(cctvApiCode('cctv4k')).toBe('cctv4k');
    expect(cctvApiCode('cctv16')).toBe('cctv16');
    expect(cctvApiCode('cctv16-4k')).toBeNull();
    expect(cctvApiCode('hunan-weishi')).toBeNull();
  });

  it('returns null for empty payloads', () => {
    expect(parseCctvEpg({}, 'cctv1')).toBeNull();
    expect(parseCctvEpg({ cctv1: { program: [] } }, 'cctv1')).toBeNull();
  });
});
