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
  /** Drop entries whose name is only digits (default true). */
  dropNumericNames?: boolean;
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
  const settings = filters ?? {};
  const groups = terms(settings.groups);
  const excludeGroups = terms(settings.excludeGroups);
  const keywords = terms(settings.keywords);
  const excludeKeywords = terms(settings.excludeKeywords);
  const dropNumericNames = settings.dropNumericNames !== false;

  const kept: T[] = [];
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    if (dropNumericNames && /^\d+$/.test(entry.name.trim())) continue;
    const group = (entry.group ?? '').toLowerCase();
    const haystack = `${group} ${name}`;
    if (groups.length && !groups.some((term) => haystack.includes(term))) continue;
    if (excludeGroups.some((term) => haystack.includes(term))) continue;
    if (keywords.length && !keywords.some((term) => name.includes(term))) continue;
    if (excludeKeywords.some((term) => name.includes(term))) continue;
    kept.push(entry);
  }

  const capped = settings.maxEntries && settings.maxEntries > 0 ? kept.slice(0, settings.maxEntries) : kept;
  return { entries: capped, dropped: entries.length - capped.length };
}
