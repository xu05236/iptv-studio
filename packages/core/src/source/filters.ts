export interface SourceFilters {
  /** Keep entries whose group/name contains one of these (empty = keep all). */
  groups?: string[];
  /** Drop entries whose group/name contains one of these. */
  excludeGroups?: string[];
  /** Keep entries whose name contains one of these. */
  keywords?: string[];
  /** Drop entries whose name contains one of these. */
  excludeKeywords?: string[];
  /** Hard cap after filtering. */
  maxEntries?: number;
}

function terms(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean);
}

/**
 * Source-level import filter. Applied before channel normalization so a huge
 * community playlist only contributes the groups the user cares about.
 */
export function filterSourceEntries<T extends { name: string; group?: string }>(
  entries: T[],
  filters?: SourceFilters | null,
): { entries: T[]; dropped: number } {
  if (!filters) return { entries, dropped: 0 };
  const groups = terms(filters.groups);
  const excludeGroups = terms(filters.excludeGroups);
  const keywords = terms(filters.keywords);
  const excludeKeywords = terms(filters.excludeKeywords);

  const kept: T[] = [];
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    const group = (entry.group ?? '').toLowerCase();
    const haystack = `${group} ${name}`;
    if (groups.length && !groups.some((term) => haystack.includes(term))) continue;
    if (excludeGroups.some((term) => haystack.includes(term))) continue;
    if (keywords.length && !keywords.some((term) => name.includes(term))) continue;
    if (excludeKeywords.some((term) => name.includes(term))) continue;
    kept.push(entry);
  }

  const capped = filters.maxEntries && filters.maxEntries > 0 ? kept.slice(0, filters.maxEntries) : kept;
  return { entries: capped, dropped: entries.length - capped.length };
}
