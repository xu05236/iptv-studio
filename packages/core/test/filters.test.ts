import { describe, expect, it } from 'vitest';
import { filterSourceEntries, type SourceFilters } from '../src/source/filters.js';

const entries = [
  { name: 'CCTV-1 综合', group: '央视' },
  { name: '湖南卫视', group: '卫视' },
  { name: '湖南卫视 4K', group: '卫视' },
  { name: '翡翠台', group: '港澳' },
  { name: 'Test 购物', group: '其他' },
];

describe('filterSourceEntries', () => {
  it('returns the input unchanged without filters', () => {
    expect(filterSourceEntries(entries, null)).toEqual({ entries, dropped: 0 });
    expect(filterSourceEntries(entries, {})).toEqual({ entries, dropped: 0 });
  });

  it('keeps entries whose group or name contains a wanted term, case-insensitively', () => {
    const result = filterSourceEntries(entries, { groups: ['卫视'] });
    expect(result.entries.map((entry) => entry.name)).toEqual([entries[1]!.name, entries[2]!.name]);

    const byName = filterSourceEntries(entries, { groups: ['cctv'] });
    expect(byName.entries.map((entry) => entry.name)).toEqual([entries[0]!.name]);
  });

  it('drops entries matched by excludeGroups or excludeKeywords', () => {
    const result = filterSourceEntries(entries, { excludeGroups: ['卫视'], excludeKeywords: ['购物'] });
    expect(result.entries.map((entry) => entry.name)).toEqual(['CCTV-1 综合', '翡翠台']);
    expect(result.dropped).toBe(3);
  });

  it('applies keywords to names only', () => {
    const result = filterSourceEntries(entries, { keywords: ['4k'] });
    expect(result.entries.map((entry) => entry.name)).toEqual(['湖南卫视 4K']);
  });

  it('caps the kept entries with maxEntries', () => {
    const result = filterSourceEntries(entries, { maxEntries: 2 });
    expect(result.entries).toHaveLength(2);
    expect(result.dropped).toBe(3);
  });

  it('ignores blank terms', () => {
    const filters: SourceFilters = { groups: ['  ', ''], excludeKeywords: [' '] };
    expect(filterSourceEntries(entries, filters).entries).toHaveLength(entries.length);
  });
});
