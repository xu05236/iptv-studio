import { describe, expect, it } from 'vitest';
import { guideIsFresh, mergeGuideFallback, type StoredGuide } from '../src/pipeline/epg.js';

const now = Date.parse('2026-11-09T04:00:00Z');
const future = now + 2 * 3_600_000;
const guide = (generatedAt: string, channels: StoredGuide['channels']): StoredGuide => ({ generatedAt, hours: 24, channels });

describe('guideIsFresh', () => {
  it('rejects a missing or empty guide', () => {
    expect(guideIsFresh(null, 12, now)).toBe(false);
    expect(guideIsFresh({ generatedAt: new Date(now).toISOString(), channels: {} }, 12, now)).toBe(false);
  });

  it('rejects a guide older than the freshness window', () => {
    const stale = new Date(now - 13 * 3_600_000).toISOString();
    expect(guideIsFresh(guide(stale, { cctv1: [{ title: '新闻联播', start: now, stop: future }] }), 12, now)).toBe(false);
  });

  it('accepts a recent non-empty guide', () => {
    const fresh = new Date(now - 3_600_000).toISOString();
    expect(guideIsFresh(guide(fresh, { cctv1: [{ title: '新闻联播', start: now, stop: future }] }), 12, now)).toBe(true);
  });
});

describe('mergeGuideFallback', () => {
  const madeAt = new Date(now - 30 * 60_000).toISOString();

  it('keeps programmes for channels the new guide does not cover', () => {
    const previous = guide(madeAt, {
      'x-old': [{ title: '旧节目', start: now, stop: future }],
      cctv1: [{ title: '旧新闻', start: now, stop: future }],
    });
    const next = guide(madeAt, { cctv1: [{ title: '新新闻', start: now, stop: future }] });
    const merged = mergeGuideFallback(previous, next, 24, now);
    expect(merged.channels?.['x-old']?.[0]?.title).toBe('旧节目');
    expect(merged.channels?.cctv1?.[0]?.title).toBe('新新闻');
  });

  it('drops expired fallback programmes', () => {
    const previous = guide(madeAt, {
      'x-old': [{ title: '过期节目', start: now - 5 * 3_600_000, stop: now - 2 * 3_600_000 }],
    });
    const merged = mergeGuideFallback(previous, guide(madeAt, {}), 24, now);
    expect(merged.channels?.['x-old']).toBeUndefined();
  });

  it('ignores a guide older than three days', () => {
    const ancient = new Date(now - 80 * 3_600_000).toISOString();
    const previous = guide(ancient, { 'x-old': [{ title: '旧节目', start: now, stop: future }] });
    const merged = mergeGuideFallback(previous, guide(madeAt, {}), 24, now);
    expect(merged.channels?.['x-old']).toBeUndefined();
  });
});
