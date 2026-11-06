import { describe, expect, it } from 'vitest';
import { effectiveRefreshHours } from '../src/refresh.js';

const now = Date.parse('2026-11-06T00:00:00Z');
const recent = new Date(now - 3 * 86_400_000).toISOString();
const old = new Date(now - 30 * 86_400_000).toISOString();

describe('effectiveRefreshHours', () => {
  it('跟随分档：收藏 12h、新增 24h、普通 72h', () => {
    expect(effectiveRefreshHours({ weight: 2, createdAt: old, now })).toBe(12);
    expect(effectiveRefreshHours({ refreshHours: null, weight: 1, createdAt: recent, now })).toBe(24);
    expect(effectiveRefreshHours({ weight: 1, createdAt: old, now })).toBe(72);
  });

  it('自定义值优先，24 小时也按自定义处理（每天一次）', () => {
    expect(effectiveRefreshHours({ refreshHours: 36, weight: 1, createdAt: old, now })).toBe(36);
    expect(effectiveRefreshHours({ refreshHours: 24, weight: 2, createdAt: old, now })).toBe(24);
    expect(effectiveRefreshHours({ refreshHours: 48, weight: 1, createdAt: old, now })).toBe(48);
    expect(effectiveRefreshHours({ refreshHours: 96, weight: 1, createdAt: old, now })).toBe(96);
  });

  it('0 表示不自动刷新', () => {
    expect(effectiveRefreshHours({ refreshHours: 0, weight: 2, createdAt: recent, now })).toBe(0);
  });
});
