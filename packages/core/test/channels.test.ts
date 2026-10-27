import { describe, expect, it } from 'vitest';
import { ChannelRegistry, classifyGroup } from '../src/normalize/channels.js';
import { normalizeChannelName } from '../src/util/text.js';

describe('channel normalisation', () => {
  it('collapses CCTV spellings', () => {
    expect(normalizeChannelName('CCTV-1 综合')).toBe('cctv1综合');
    expect(normalizeChannelName('CCTV1')).toBe('cctv1');
    expect(normalizeChannelName('CCTV-5+')).toBe('cctv5plus');
    expect(normalizeChannelName('CCTV-4K 超高清')).toContain('cctv4k');
  });

  it('strips quality markers from satellite channels', () => {
    expect(normalizeChannelName('湖南卫视高清')).toBe('湖南卫视');
    expect(normalizeChannelName('湖南卫视 [1080P]')).toBe('湖南卫视');
  });
});

describe('ChannelRegistry', () => {
  const registry = new ChannelRegistry();

  it('resolves aliases and tvg ids to one channel', () => {
    expect(registry.resolve('CCTV1').id).toBe('cctv1');
    expect(registry.resolve('CCTV-1 综合').id).toBe('cctv1');
    expect(registry.resolve('中央一台').id).toBe('cctv1');
    expect(registry.resolve('cctv-1', { tvgId: 'CCTV1' }).id).toBe('cctv1');
    expect(registry.resolve('Hunan TV', { tvgId: '湖南卫视' }).id).toBe('hunan-weishi');
  });

  it('handles quality variants', () => {
    expect(registry.resolve('CCTV5+').id).toBe('cctv5plus');
    expect(registry.resolve('CCTV-4K').id).toBe('cctv4k');
    expect(registry.resolve('湖南卫视高清').id).toBe('hunan-weishi');
  });

  it('creates stable ids for unknown channels', () => {
    const first = registry.resolve('某某县电视台');
    const second = registry.resolve('某某县电视台');
    expect(first.created).toBe(true);
    expect(first.id).toBe(second.id);
    expect(first.group).toBe('地方');
  });

  it('classifies groups', () => {
    expect(classifyGroup('CCTV-1 综合')).toBe('央视');
    expect(classifyGroup('湖南卫视')).toBe('卫视');
    expect(classifyGroup('翡翠台')).toBe('港澳台');
    expect(classifyGroup('劲爆体育')).toBe('体育');
    expect(classifyGroup('金鹰卡通')).toBe('少儿');
  });
});
