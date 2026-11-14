import { describe, expect, it } from 'vitest';
import { channelIdentityKey } from '../src/util/text.js';
import { hasChannelNameNoise, planChannelMerges, remapLineChannels } from '../src/state/channelDedupe.js';

describe('channelIdentityKey', () => {
  it('drops speed tags and quality suffixes', () => {
    expect(channelIdentityKey('安徽卫视 (0.001 MB/s)')).toBe(channelIdentityKey('安徽卫视'));
    expect(channelIdentityKey('北京卫视 (0.576 MB/s)')).toBe(channelIdentityKey('北京卫视'));
    expect(channelIdentityKey('湖南卫视 HD')).toBe(channelIdentityKey('湖南卫视'));
    expect(channelIdentityKey('CCTV-1 综合（高清）')).toBe(channelIdentityKey('CCTV-1 综合'));
  });

  it('keeps meaningful qualifiers', () => {
    expect(channelIdentityKey('CCTV-5+ 体育赛事')).toBe(channelIdentityKey('CCTV5+ 体育赛事'));
    expect(channelIdentityKey('凤凰卫视资讯台')).not.toBe(channelIdentityKey('凤凰卫视中文台'));
  });

  it('drops MCP and leading mirror markers', () => {
    expect(channelIdentityKey('安徽卫视-MCP')).toBe(channelIdentityKey('安徽卫视'));
    expect(channelIdentityKey('*CCTV3 (0.001 MB/s)')).toBe(channelIdentityKey('CCTV-3'));
  });
});

describe('remapLineChannels', () => {
  it('remaps all lines in one pass and keeps per-source keys', () => {
    const lines = [
      { key: 'a', channelId: 'old-1' },
      { key: 'b', channelId: 'old-2' },
      { key: 'c', channelId: 'keep' },
    ];
    const result = remapLineChannels(lines, new Map([['old-1', 'new'], ['old-2', 'new']]));
    expect(result.changed).toBe(2);
    expect(lines.map((line) => line.channelId)).toEqual(['new', 'new', 'keep']);
    expect(result.movedKeys.get('old-1')).toEqual(['a']);
    expect(result.movedKeys.get('old-2')).toEqual(['b']);
  });
});

describe('hasChannelNameNoise', () => {
  it('detects speed and quality noise', () => {
    expect(hasChannelNameNoise('安徽卫视 (0.001 MB/s)')).toBe(true);
    expect(hasChannelNameNoise('湖南卫视高清')).toBe(true);
    expect(hasChannelNameNoise('安徽卫视-MCP')).toBe(true);
    expect(hasChannelNameNoise('*CCTV3')).toBe(true);
    expect(hasChannelNameNoise('湖南卫视')).toBe(false);
  });
});

describe('planChannelMerges', () => {
  it('merges noisy duplicates into the clean channel', () => {
    const result = planChannelMerges([
      { id: 'anhui', name: '安徽卫视', group: '卫视', tvgId: '安徽卫视', lines: 20, alive: 14 },
      { id: 'anhui-speed', name: '安徽卫视 (0.001 MB/s)', group: '卫视频道', lines: 1, alive: 1 },
      { id: 'anhui-fast', name: '安徽卫视 (2.809 MB/s)', group: '卫视频道', lines: 1, alive: 1 },
    ]);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]!.into.id).toBe('anhui');
    expect(result.plans[0]!.from.map((item) => item.id).sort()).toEqual(['anhui-fast', 'anhui-speed']);
    expect(result.plans[0]!.lines).toBe(2);
  });

  it('leaves ambiguous same-name channels alone', () => {
    const result = planChannelMerges([
      { id: 'a', name: '综合', group: '地方' },
      { id: 'b', name: '综合', group: '地方' },
    ]);
    expect(result.plans).toHaveLength(0);
    expect(result.skippedAmbiguous).toBe(1);
  });

  it('skips entertainment groups', () => {
    const result = planChannelMerges([
      { id: 'h1', name: '周星星', group: '虎牙频道' },
      { id: 'h2', name: '周星星 (0.001 MB/s)', group: '虎牙频道' },
    ]);
    expect(result.plans).toHaveLength(0);
  });

  it('merges MCP mirrors into the clean channel', () => {
    const result = planChannelMerges([
      { id: 'anhui', name: '安徽卫视', group: '卫视', tvgId: '安徽卫视', lines: 20, alive: 14 },
      { id: 'anhui-mcp', name: '安徽卫视-MCP', group: '卫视-MCP', lines: 2, alive: 1 },
    ]);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]!.into.id).toBe('anhui');
    expect(result.plans[0]!.from[0]!.id).toBe('anhui-mcp');
  });
});
