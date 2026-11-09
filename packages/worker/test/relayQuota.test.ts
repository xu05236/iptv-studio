import { beforeEach, describe, expect, it } from 'vitest';
import { recordRelayUse, relayQuotaExceeded, relayQuotaRetryAfter, setRelayQuotaLimits } from '../src/lib/relayQuota.js';

const noonUtc = Date.UTC(2026, 10, 9, 12, 0, 0);

describe('relay quota', () => {
  beforeEach(() => setRelayQuotaLimits({ requests: 3, bytes: 1_000 }));

  it('allows traffic under both limits', () => {
    expect(relayQuotaExceeded('token:a', noonUtc)).toBe(false);
    expect(recordRelayUse('token:a', 100, noonUtc)).toBe(false);
    expect(relayQuotaExceeded('token:a', noonUtc)).toBe(false);
  });

  it('blocks once the request limit is reached', () => {
    recordRelayUse('token:b', 0, noonUtc);
    recordRelayUse('token:b', 0, noonUtc);
    expect(recordRelayUse('token:b', 0, noonUtc)).toBe(true);
    expect(relayQuotaExceeded('token:b', noonUtc)).toBe(true);
  });

  it('blocks once the byte limit is reached', () => {
    recordRelayUse('token:c', 2_000, noonUtc);
    expect(relayQuotaExceeded('token:c', noonUtc)).toBe(true);
  });

  it('resets on the next UTC day', () => {
    recordRelayUse('token:d', 5_000, noonUtc);
    expect(relayQuotaExceeded('token:d', noonUtc)).toBe(true);
    expect(relayQuotaExceeded('token:d', noonUtc + 86_400_000)).toBe(false);
  });

  it('reports seconds until the UTC midnight reset', () => {
    expect(relayQuotaRetryAfter(noonUtc)).toBe(12 * 3600);
    expect(relayQuotaRetryAfter(noonUtc + 11 * 3600_000)).toBe(3600);
  });

  it('keeps separate counters per token', () => {
    recordRelayUse('token:e', 5_000, noonUtc);
    expect(relayQuotaExceeded('token:e', noonUtc)).toBe(true);
    expect(relayQuotaExceeded('token:f', noonUtc)).toBe(false);
  });
});
