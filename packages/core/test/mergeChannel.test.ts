import { describe, expect, it } from 'vitest';
import { ChannelRegistry, isMergedChannelId, mergedChannelId } from '../src/normalize/channels.js';

describe('merged channel for live-platform sources', () => {
  it('folds many stream rooms into one channel with the requested group', () => {
    const registry = new ChannelRegistry();
    const first = registry.resolve('虎牙直播', { group: '影视' });
    const second = registry.resolve('虎牙直播', { group: '影视' });
    expect(second.id).toBe(first.id);
    const channel = registry.list().find((item) => item.id === first.id);
    expect(channel?.name).toBe('虎牙直播');
    expect(channel?.group).toBe('影视频道');
  });

  it('keeps explicit channel names apart', () => {
    const registry = new ChannelRegistry();
    const huya = registry.resolve('虎牙直播', { group: '影视' });
    const douyu = registry.resolve('斗鱼直播', { group: '影视' });
    expect(douyu.id).not.toBe(huya.id);
  });
});

describe('merged channel ids', () => {
  it('is deterministic per source and recognisable', () => {
    expect(mergedChannelId('src-huya')).toBe('x-mc-src-huya');
    expect(isMergedChannelId('x-mc-src-huya')).toBe(true);
    expect(isMergedChannelId('cctv1')).toBe(false);
  });
});
