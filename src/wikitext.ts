import type { LicenseId } from './types';

export const LICENSES: { id: LicenseId; label: string; template: string }[] = [
  { id: 'cc-by-4.0', label: 'CC BY 4.0', template: '{{self|cc-by-4.0}}' },
  { id: 'cc-by-sa-4.0', label: 'CC BY-SA 4.0', template: '{{self|cc-by-sa-4.0}}' },
  { id: 'cc0', label: 'CC0 1.0', template: '{{self|cc-zero}}' },
];

export function licenseTemplate(id: LicenseId): string {
  return LICENSES.find((l) => l.id === id)?.template ?? LICENSES[0].template;
}

export function normalizeCategory(raw: string): string {
  return raw.trim().replace(/^category:/i, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

export function dedupeCategories(cats: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of cats) {
    const c = normalizeCategory(raw);
    const key = c.toLowerCase();
    if (!c || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export interface WikitextInput {
  description: string;
  dateIso: string;
  username: string;
  licenseId: LicenseId;
  categories: string[];
  pwaCategory: string;
}

/**
 * File page wikitext. User categories come first; the implicit PWA category is
 * always the last line, separated from them by one empty line.
 */
export function buildWikitext(o: WikitextInput): string {
  const cats = dedupeCategories(o.categories).filter(
    (c) => c.toLowerCase() !== o.pwaCategory.toLowerCase(),
  );
  const lines = [
    '=={{int:filedesc}}==',
    '{{Information',
    `|description=${o.description.trim()}`,
    `|date=${o.dateIso}`,
    '|source={{own}}',
    `|author=[[User:${o.username}|${o.username}]]`,
    '}}',
    '',
    '=={{int:license-header}}==',
    licenseTemplate(o.licenseId),
    '',
  ];
  for (const c of cats) lines.push(`[[Category:${c}]]`);
  if (cats.length) lines.push('');
  lines.push(`[[Category:${o.pwaCategory}]]`);
  return lines.join('\n');
}
