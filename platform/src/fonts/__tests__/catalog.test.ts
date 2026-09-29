import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseManifest } from '../catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.resolve(__dirname, '../../../../fonts/fonts.json');

describe('parseManifest', () => {
  it('parses a well-formed manifest', () => {
    const { catalog, defaults } = parseManifest({
      version: 1,
      defaults: ['Alpha'],
      fonts: [
        { name: 'Alpha', file: 'alpha.ttf' },
        { name: 'Beta', file: 'beta.otf' },
      ],
    });
    expect(catalog).toEqual([
      { name: 'Alpha', file: 'alpha.ttf' },
      { name: 'Beta', file: 'beta.otf' },
    ]);
    expect(defaults).toEqual(['Alpha']);
  });

  it('drops malformed entries but keeps valid ones', () => {
    const { catalog } = parseManifest({
      fonts: [
        { name: 'Good', file: 'good.ttf' },
        { name: '', file: 'empty-name.ttf' },
        { name: 'NoFile' },
        { file: 'no-name.ttf' },
        null,
        { name: 'AlsoGood', file: 'also.otf' },
      ],
    });
    expect(catalog.map(f => f.name)).toEqual(['Good', 'AlsoGood']);
  });

  it('deduplicates by name (first wins)', () => {
    const { catalog } = parseManifest({
      fonts: [
        { name: 'Dup', file: 'first.ttf' },
        { name: 'Dup', file: 'second.ttf' },
      ],
    });
    expect(catalog).toEqual([{ name: 'Dup', file: 'first.ttf' }]);
  });

  it('filters defaults to names that exist in the catalog', () => {
    const { defaults } = parseManifest({
      defaults: ['Alpha', 'Ghost'],
      fonts: [{ name: 'Alpha', file: 'a.ttf' }],
    });
    expect(defaults).toEqual(['Alpha']);
  });

  it('falls back to built-in defaults present in catalog when defaults omitted', () => {
    const { defaults } = parseManifest({
      fonts: [
        { name: 'Cormorant', file: 'c.otf' },
        { name: 'Random', file: 'r.ttf' },
      ],
    });
    // "Cormorant" is a built-in default; "Random" is not.
    expect(defaults).toContain('Cormorant');
    expect(defaults).not.toContain('Random');
  });

  it('falls back to first entries when no defaults match', () => {
    const { defaults } = parseManifest({
      fonts: [
        { name: 'One', file: '1.ttf' },
        { name: 'Two', file: '2.ttf' },
      ],
    });
    expect(defaults).toEqual(['One', 'Two']);
  });

  it('throws when fonts array is missing', () => {
    expect(() => parseManifest({})).toThrow(/missing "fonts"/);
  });

  it('throws when there are no valid entries', () => {
    expect(() => parseManifest({ fonts: [{ name: '', file: '' }] })).toThrow(/no valid font/);
  });
});

describe('shipped fonts/fonts.json', () => {
  it('is valid and parses with a non-empty catalog and defaults', () => {
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
    const { catalog, defaults } = parseManifest(raw);
    expect(catalog.length).toBeGreaterThan(0);
    expect(defaults.length).toBeGreaterThan(0);

    // Every default references a real catalog name.
    const names = new Set(catalog.map(f => f.name));
    for (const d of defaults) {
      expect(names.has(d), `default "${d}" exists in catalog`).toBe(true);
    }

    // No duplicate names.
    expect(names.size).toBe(catalog.length);
  });
});
