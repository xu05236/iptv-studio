import { describe, expect, it } from 'vitest';
import { applyRules, compileRules } from '../src/aggregate/rules.js';
import type { ChannelConfig, LineEntry, Rule } from '../src/types.js';

function line(group: string, name = '测试频道'): LineEntry {
  return { key: 'k', channelId: 'c', sourceId: 's', name, url: 'http://example.com/a.m3u8', urlKey: 'uk', group } as LineEntry;
}

const channel = { id: 'c', name: '测试频道', group: '地方' } as ChannelConfig;

const rule: Rule = {
  id: 'rule-huyu',
  name: '虎牙线路归组',
  enabled: true,
  priority: 100,
  match: { lineGroups: ['虎牙', '虎牙影视'] },
  actions: { setGroup: '虎牙频道' },
};

describe('rule lineGroups', () => {
  it('matches lines by their source-provided group', () => {
    const result = applyRules(channel, [line('虎牙')], compileRules([rule]));
    expect(result.channel.group).toBe('虎牙频道');
    expect(result.appliedRules).toContain('rule-huyu');
  });

  it('ignores lines with other source groups', () => {
    const result = applyRules(channel, [line('斗鱼')], compileRules([rule]));
    expect(result.channel.group).toBe('地方');
    expect(result.appliedRules).toEqual([]);
  });

  it('trims whitespace around the source group', () => {
    const result = applyRules(channel, [line(' 虎牙 ')], compileRules([rule]));
    expect(result.channel.group).toBe('虎牙频道');
  });
});
