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

  it('does not collapse when there are no tested lines yet', () => {
    const score = nextReputation({
      previous: 15,
      alive: 0,
      total: 0,
      avgScore: 0,
      fetchOk: true,
      consecutiveFailures: 0,
    });
    expect(score).toBeGreaterThan(20);
  });

  it('penalises fetch failures', () => {
    const ok = nextReputation({ previous: 60, alive: 50, total: 100, avgScore: 50, fetchOk: true, consecutiveFailures: 0 });
    const failed = nextReputation({ previous: 60, alive: 50, total: 100, avgScore: 50, fetchOk: false, consecutiveFailures: 1 });
    expect(failed).toBeLessThan(ok);
  });
});
