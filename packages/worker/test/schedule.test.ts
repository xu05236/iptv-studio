import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@iptv/core';
import { mostRecentScheduledAt, nextAutoLivenessAt, nextScheduledAt, parseCollectTimes } from '../src/lib/schedule.js';

describe('parseCollectTimes', () => {
  it('parses, de-duplicates and sorts Beijing-local times', () => {
    expect(parseCollectTimes('08:30, 8:30, 20:05, bad, 24:00')).toEqual([
      { hour: 8, minute: 30 },
      { hour: 20, minute: 5 },
    ]);
  });
});

describe('schedule instants', () => {
  const times = parseCollectTimes('08:30');

  it('finds the most recent occurrence across the Beijing day boundary', () => {
    // 2026-10-30 08:35 Beijing == 00:35 UTC
    const now = Date.parse('2026-10-30T00:35:00Z');
    expect(mostRecentScheduledAt(times, now)).toBe(Date.parse('2026-10-30T00:30:00Z'));
  });

  it('finds the next occurrence tomorrow when today already passed', () => {
    const now = Date.parse('2026-10-30T00:35:00Z');
    expect(nextScheduledAt(times, now)).toBe(Date.parse('2026-10-31T00:30:00Z'));
  });

  it('handles times just after Beijing midnight', () => {
    // 2026-10-30 00:20 Beijing == 2026-10-29 16:20 UTC
    const now = Date.parse('2026-10-29T16:20:00Z');
    expect(nextScheduledAt(parseCollectTimes('00:30'), now)).toBe(Date.parse('2026-10-29T16:30:00Z'));
  });

  it('computes the daily liveness slot only when enabled', () => {
    // 2026-10-30 20:35 Beijing == 12:35 UTC; next 20:30 is tomorrow.
    const now = Date.parse('2026-10-30T12:35:00Z');
    const enabled = { ...DEFAULT_SETTINGS, autoLivenessEnabled: true, autoLivenessTimes: '20:30' };
    expect(nextAutoLivenessAt(enabled, now)).toBe(Date.parse('2026-10-31T12:30:00Z'));
    expect(nextAutoLivenessAt({ ...enabled, autoLivenessEnabled: false }, now)).toBeNull();
  });
});
