import { describe, expect, it } from 'vitest';
import { nextReputation } from '../src/aggregate/reputation.js';

describe('nextReputation', () => {
  it('uses tested lines and recovers a historically low source', () => {
    const score = nextReputation({
      previous: 28,
      alive: 90,
      total: 100,
      avgScore: 50,
      fetchOk: true,
      consecutiveFailures: 0,
    });
    expect(score).toBeGreaterThanOrEqual(60);
    expect(score).toBeLessThanOrEqual(85);
  });

  it('keeps the previous score when there are too few probed lines', () => {
    const score = nextReputation({
      previous: 15,
      alive: 0,
      total: 0,
      avgScore: 0,
      fetchOk: true,
      consecutiveFailures: 0,
    });
    expect(score).toBe(15);
  });

  it('only applies a small fetch penalty without enough evidence', () => {
    const score = nextReputation({
      previous: 40,
      alive: 0,
      total: 5,
      avgScore: 0,
      fetchOk: false,
      consecutiveFailures: 1,
    });
    expect(score).toBe(35);
  });

  it('penalises fetch failures', () => {
    const ok = nextReputation({ previous: 60, alive: 50, total: 100, avgScore: 50, fetchOk: true, consecutiveFailures: 0 });
    const failed = nextReputation({ previous: 60, alive: 50, total: 100, avgScore: 50, fetchOk: false, consecutiveFailures: 1 });
    expect(failed).toBeLessThan(ok);
  });
});
