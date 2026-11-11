import { describe, expect, it } from 'vitest';
import { aggregateGithubRuns } from '../src/lib/usage.js';

describe('aggregateGithubRuns', () => {
  it('sums run durations and ignores runs from previous months', () => {
    const result = aggregateGithubRuns(
      [
        { run_duration_ms: 60_000, created_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-02T00:01:00Z' },
        { run_duration_ms: 120_000, created_at: '2026-11-02T01:00:00Z', updated_at: '2026-11-02T01:02:00Z' },
        { run_duration_ms: 600_000, created_at: '2026-10-31T23:00:00Z', updated_at: '2026-10-31T23:10:00Z' },
      ],
      '2026-11-01',
    );
    expect(result.runs).toBe(2);
    expect(result.minutes).toBe(3);
    expect(result.byDay.get('2026-11-02')).toBe(3);
  });

  it('falls back to the created/updated delta when duration is missing', () => {
    const result = aggregateGithubRuns(
      [{ created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:01:30Z' }],
      '2026-11-01',
    );
    expect(result.minutes).toBe(1.5);
    expect(result.runs).toBe(1);
  });

  it('prefers run_started_at and caps queue/log-cleanup inflation', () => {
    const result = aggregateGithubRuns(
      [
        { created_at: '2026-11-01T00:00:00Z', run_started_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-01T10:05:00Z' },
        { created_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-04T00:00:00Z' },
      ],
      '2026-11-01',
    );
    expect(result.minutes).toBe(65);
  });

  it('does not count queued runs as minutes', () => {
    const result = aggregateGithubRuns(
      [{ status: 'queued', created_at: '2026-11-05T00:00:00Z', updated_at: '2026-11-06T00:00:00Z' }],
      '2026-11-01',
    );
    expect(result.minutes).toBe(0);
    expect(result.runs).toBe(1);
  });
});
