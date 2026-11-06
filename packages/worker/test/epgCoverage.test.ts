import { describe, expect, it } from 'vitest';
import { summarizeCoverage } from '../src/lib/epgCoverage.js';

const now = new Date('2026-03-01T12:00:00Z').getTime();
const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();

describe('EPG coverage', () => {
  it('counts channels with future programmes as covered', () => {
    const summary = summarizeCoverage(['a', 'b'], {
      generatedAt: at(-2),
      channels: { a: [{ end: at(2) }], b: [{ end: at(1) }] },
    }, now);
    expect(summary.covered).toBe(2);
    expect(summary.percent).toBe(100);
    expect(summary.guideStale).toBe(false);
  });

  it('separates expired programme lists from missing ones', () => {
    const summary = summarizeCoverage(['a', 'b', 'c'], {
      generatedAt: at(-2),
      channels: { a: [{ end: at(1) }], b: [{ end: at(-1) }] },
    }, now);
    expect(summary.covered).toBe(1);
    expect(summary.stale).toBe(1);
    expect(summary.missingIds).toEqual(['c']);
    expect(summary.staleIds).toEqual(['b']);
    expect(summary.percent).toBe(33);
  });

  it('marks a guide older than 26 hours as stale', () => {
    const summary = summarizeCoverage(['a'], {
      generatedAt: at(-27),
      channels: { a: [{ end: at(1) }] },
    }, now);
    expect(summary.guideStale).toBe(true);
    expect(summary.guideAgeHours).toBe(27);
  });

  it('treats a missing generatedAt as stale and empty guide as zero coverage', () => {
    const summary = summarizeCoverage(['a'], { channels: {} }, now);
    expect(summary.guideStale).toBe(true);
    expect(summary.covered).toBe(0);
  });
});
