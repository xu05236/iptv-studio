import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@iptv/core';
import { actionsAllowance, intervalDue, isStuckTask, mostRecentScheduledAt, nextAutoLivenessAt, nextScheduledAt, parseCollectTimes } from '../src/lib/schedule.js';

describe('global fetch cadence', () => {
  const now = Date.parse('2026-11-09T00:00:00Z');

  it('runs daily when the interval is 1', () => {
    expect(intervalDue(null, 1, now)).toBe(true);
    expect(intervalDue(new Date(now - 3_600_000).toISOString(), 1, now)).toBe(true);
  });

  it('skips until N days have passed, then runs', () => {
    expect(intervalDue(new Date(now - 86_400_000).toISOString(), 2, now)).toBe(false);
    expect(intervalDue(new Date(now - 2 * 86_400_000).toISOString(), 2, now)).toBe(true);
    expect(intervalDue(new Date(now - 6 * 86_400_000).toISOString(), 7, now)).toBe(false);
    expect(intervalDue(new Date(now - 7 * 86_400_000).toISOString(), 7, now)).toBe(true);
  });
});

describe('actions allowance pacing', () => {
  const now = Date.parse('2026-11-06T02:00:00Z');

  it('spreads the remaining monthly budget across the remaining days', () => {
    const allowance = actionsAllowance({ used: 753, budget: 2000, reserve: 300, runCost: 6, now, autoRunsToday: 0 });
    expect(allowance.remaining).toBe(947);
    expect(allowance.daysLeft).toBe(25);
    expect(allowance.allowedAutoRuns).toBe(6);
    expect(allowance.blocked).toBe(false);
  });

  it('blocks once today uses more runs than the paced allowance', () => {
    const allowance = actionsAllowance({ used: 753, budget: 2000, reserve: 300, runCost: 6, now, autoRunsToday: 6 });
    expect(allowance.blocked).toBe(true);
  });

  it('blocks when budget minus manual reserve is exhausted', () => {
    const allowance = actionsAllowance({ used: 1800, budget: 2000, reserve: 300, runCost: 6, now, autoRunsToday: 0 });
    expect(allowance.remaining).toBe(0);
    expect(allowance.blocked).toBe(true);
  });

  it('allows a full daily share at the start of a month', () => {
    const allowance = actionsAllowance({ used: 0, budget: 2000, reserve: 300, runCost: 6, now: Date.parse('2026-11-01T02:00:00Z'), autoRunsToday: 0 });
    expect(allowance.allowedAutoRuns).toBe(9);
    expect(allowance.blocked).toBe(false);
  });
});

describe('parseCollectTimes', () => {
  it('parses, de-duplicates and sorts Beijing-local times', () => {
    expect(parseCollectTimes('08:30, 8:30, 20:05, bad, 24:00')).toEqual([
      { hour: 8, minute: 30 },
      { hour: 20, minute: 5 },
    ]);
  });
});

describe('stuck task recovery', () => {
  const now = Date.parse('2026-11-05T08:00:00Z');
  const base = {
    status: 'running' as const,
    createdAt: new Date(now - 2 * 3_600_000).toISOString(),
    startedAt: new Date(now - 89 * 60_000).toISOString(),
    lastHeartbeatAt: undefined,
  };

  it('does not recover a task that is still within the timeout', () => {
    expect(isStuckTask(base, now)).toBe(false);
  });

  it('recovers a running task with no progress for more than 90 minutes', () => {
    expect(isStuckTask({ ...base, startedAt: new Date(now - 91 * 60_000).toISOString() }, now)).toBe(true);
  });

  it('uses a fresh heartbeat to keep a long task alive', () => {
    expect(isStuckTask({ ...base, startedAt: new Date(now - 3 * 3_600_000).toISOString(), lastHeartbeatAt: new Date(now - 5 * 60_000).toISOString() }, now)).toBe(false);
  });

  it('never recovers queued tasks', () => {
    expect(isStuckTask({ ...base, status: 'queued' }, now)).toBe(false);
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
