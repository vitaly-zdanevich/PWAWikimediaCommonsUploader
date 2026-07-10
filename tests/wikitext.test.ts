import { describe, expect, it } from 'vitest';
import { buildWikitext, dedupeCategories, licenseTemplate, normalizeCategory } from '../src/wikitext';

const base = {
  description: 'A test photo',
  dateIso: '2026-07-11',
  username: 'Example User',
  licenseId: 'cc-by-4.0' as const,
  pwaCategory: 'Uploaded by PWA from Vitaly Zdanevich',
};

describe('buildWikitext', () => {
  it('puts the PWA category on the last line, separated by an empty line', () => {
    const text = buildWikitext({ ...base, categories: ['Batumi', 'Cats'] });
    const lines = text.split('\n');
    expect(lines[lines.length - 1]).toBe('[[Category:Uploaded by PWA from Vitaly Zdanevich]]');
    expect(lines[lines.length - 2]).toBe('');
    expect(lines[lines.length - 3]).toBe('[[Category:Cats]]');
    expect(lines[lines.length - 4]).toBe('[[Category:Batumi]]');
  });

  it('works with no user categories', () => {
    const text = buildWikitext({ ...base, categories: [] });
    expect(text.endsWith('\n\n[[Category:Uploaded by PWA from Vitaly Zdanevich]]')).toBe(true);
    expect(text).not.toContain('\n\n\n');
  });

  it('does not duplicate the PWA category if the user added it', () => {
    const text = buildWikitext({ ...base, categories: ['uploaded by PWA from Vitaly Zdanevich'] });
    expect(text.match(/Uploaded by PWA/g)).toHaveLength(1);
  });

  it('contains Information template fields', () => {
    const text = buildWikitext({ ...base, categories: [] });
    expect(text).toContain('|description=A test photo');
    expect(text).toContain('|date=2026-07-11');
    expect(text).toContain('|author=[[User:Example User|Example User]]');
    expect(text).toContain('{{self|cc-by-4.0}}');
  });
});

describe('categories helpers', () => {
  it('normalizes prefix and underscores', () => {
    expect(normalizeCategory(' Category:Foo_bar ')).toBe('Foo bar');
  });

  it('dedupes case-insensitively', () => {
    expect(dedupeCategories(['Foo', 'foo', 'Category:Foo', 'Bar'])).toEqual(['Foo', 'Bar']);
  });
});

describe('licenseTemplate', () => {
  it('maps ids to templates', () => {
    expect(licenseTemplate('cc-by-4.0')).toBe('{{self|cc-by-4.0}}');
    expect(licenseTemplate('cc-by-sa-4.0')).toBe('{{self|cc-by-sa-4.0}}');
    expect(licenseTemplate('cc0')).toBe('{{self|cc-zero}}');
  });
});
