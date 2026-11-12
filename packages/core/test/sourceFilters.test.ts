import { describe, expect, it } from 'vitest';
import { filterSourceEntries } from '../src/source/filters.js';

const entries = [
  { name: '1', group: '地方' },
  { name: '106', group: '地方' },
  { name: 'CCTV-1', group: '央视' },
  { name: ' 2 ', group: '地方' },
];

describe('filterSourceEntries numeric names', () => {
  it('drops numeric-only names by default, even without filters', () => {
    const result = filterSourceEntries(entries, null);
    expect(result.entries.map((entry) => entry.name)).toEqual(['CCTV-1']);
    expect(result.dropped).toBe(3);
  });

  it('keeps numeric names when explicitly disabled', () => {
    const result = filterSourceEntries(entries, { dropNumericNames: false });
    expect(result.entries).toHaveLength(4);
    expect(result.dropped).toBe(0);
  });

  it('still applies other filters', () => {
    const result = filterSourceEntries(entries, { excludeGroups: ['地方'] });
    expect(result.entries.map((entry) => entry.name)).toEqual(['CCTV-1']);
  });
});
