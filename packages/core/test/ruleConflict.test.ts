import { describe, expect, it } from 'vitest';
import type { ChannelConfig, LineEntry, Rule } from '../src/types.js';
import { applyRules, compileRules } from '../src/aggregate/rules.js';

function rule(overrides: Partial<Rule> & { id: string; priority: number }): Rule {
  return {
    name: overrides.id,
    enabled: true,
    match: {},
    actions: {},
    ...overrides,
  } as Rule;
}

function channel(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    id: 'x-test',
    name: '测试频道',
    group: '地方',
    aliases: [],
    ...overrides,
  } as ChannelConfig;
}

function line(overrides: Partial<LineEntry> = {}): LineEntry {
  return {
    key: 'k',
    channelId: 'x-test',
    name: '线路',
    url: 'http://example.test/live.m3u8',
    sourceId: 'src-a',
    group: '虎牙',
    protocol: 'hls',
    resolution: '1080p',
    speedKbps: 1000,
    status: 'alive',
    tags: [],
    ...overrides,
  } as LineEntry;
}

describe('rule conflicts on one channel', () => {
  it('lets the higher priority rule win when two rules set the group', () => {
    const rules = compileRules([
      rule({ id: 'rule-a', priority: 100, match: { lineGroups: ['虎牙'] }, actions: { setGroup: '虎牙频道' } }),
      rule({ id: 'rule-b', priority: 200, match: { lineGroups: ['虎牙'] }, actions: { setGroup: '斗鱼频道' } }),
    ]);
    const result = applyRules(channel(), [line()], rules);
    expect(result.channel.group).toBe('斗鱼频道');
  });

  it('keeps a stable winner for equal priorities regardless of input order', () => {
    const a = rule({ id: 'rule-a', priority: 100, match: { lineGroups: ['虎牙'] }, actions: { setGroup: 'A' } });
    const b = rule({ id: 'rule-b', priority: 100, match: { lineGroups: ['虎牙'] }, actions: { setGroup: 'B' } });
    expect(applyRules(channel(), [line()], compileRules([a, b])).channel.group).toBe('A');
    expect(applyRules(channel(), [line()], compileRules([b, a])).channel.group).toBe('A');
  });

  it('resolves the channel once even when different lines match different rules', () => {
    const rules = compileRules([
      rule({ id: 'rule-huya', priority: 100, match: { lineGroups: ['虎牙'] }, actions: { setGroup: '虎牙频道' } }),
      rule({ id: 'rule-yy', priority: 102, match: { lineGroups: ['YY'] }, actions: { setGroup: 'YY频道' } }),
    ]);
    const huya = line({ key: 'huya', group: '虎牙' });
    const yy = line({ key: 'yy', group: 'YY' });
    expect(applyRules(channel(), [huya, yy], rules).channel.group).toBe('YY频道');
    expect(applyRules(channel(), [yy, huya], rules).channel.group).toBe('YY频道');
  });

  it('still drops excluded lines and merges tags from matching rules', () => {
    const rules = compileRules([
      rule({ id: 'rule-tag', priority: 10, match: { namePattern: '线路' }, actions: { addTags: ['checked'] } }),
      rule({ id: 'rule-drop', priority: 20, match: { namePattern: '广告' }, actions: { exclude: true } }),
    ]);
    const result = applyRules(channel(), [line({ key: 'ok' }), line({ key: 'bad', name: '广告线路' })], rules);
    expect(result.lines.map((item) => item.key)).toEqual(['ok']);
    expect(result.lines[0]?.tags).toEqual(['checked']);
  });
});
