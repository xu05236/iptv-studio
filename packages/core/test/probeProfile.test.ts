import { describe, expect, it } from 'vitest';
import { activeProbeProfile, DEFAULT_SETTINGS } from '../src/types.js';

describe('activeProbeProfile', () => {
  it('uses the private template by default', () => {
    expect(activeProbeProfile(DEFAULT_SETTINGS)).toEqual({
      batchSize: 1200,
      intervalHours: 8,
      maxDailyDispatches: 20,
    });
  });

  it('switches to the public template without touching the private one', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      actionsRepoMode: 'public' as const,
      publicProbeBatchSize: 3000,
      publicProbeIntervalHours: 1,
      publicMaxDailyDispatches: 40,
    };
    expect(activeProbeProfile(settings)).toEqual({ batchSize: 3000, intervalHours: 1, maxDailyDispatches: 40 });
    expect(activeProbeProfile({ ...settings, actionsRepoMode: 'private' })).toEqual({
      batchSize: 1200,
      intervalHours: 8,
      maxDailyDispatches: 20,
    });
  });

  it('falls back to safe defaults for empty values', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      actionsRepoMode: 'public' as const,
      publicProbeBatchSize: 0,
      publicProbeIntervalHours: 0,
      publicMaxDailyDispatches: 0,
    };
    expect(activeProbeProfile(settings)).toEqual({ batchSize: 2000, intervalHours: 2, maxDailyDispatches: 30 });
  });
});
