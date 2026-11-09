import { describe, expect, it } from 'vitest';
import { networkIssue } from '../src/source/fetch.js';

describe('networkIssue', () => {
  it('finds an error code on the cause chain', () => {
    const error = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND example.invalid'), { code: 'ENOTFOUND' }),
    });
    expect(networkIssue(error)).toBe('ENOTFOUND');
  });

  it('finds an error code inside an AggregateError', () => {
    const aggregate = Object.assign(new Error('connect ECONNREFUSED'), {
      errors: [Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    });
    expect(networkIssue(aggregate)).toBe('ECONNREFUSED');
  });

  it('returns null when no code is present', () => {
    expect(networkIssue(new Error('fetch failed'))).toBeNull();
  });
});
