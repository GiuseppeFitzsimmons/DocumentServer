/**
 * Font Resolver - maps font usage records to actual font files on disk.
 *
 * Resolution strategy (in order):
 * 1. Consult the lookup table JSON for an explicit family→filename-prefix mapping
 * 2. Case-insensitive match of font family name against filenames (stripping spaces/hyphens)
 * 3. Select best variant match based on filename indicators
 */

import { readdir, readFile } from 'fs/promises';
import path from 'path';
import type { FontUsageRecord, FontResolutionResult } from './font-types.js';

export interface FontResolverConfig {
  fontDirs: string[];
  lookupTablePath?: string;
}

/**
 * Resolves a list of font usage records to actual font files on disk.
 *
 * @param records - Font usage records extracted from a docx file
 * @param config - Configuration specifying font directories and optional lookup table path
 * @returns Resolution results mapping each record to a file path or null
 */
export async function resolveFonts(
  records: FontUsageRecord[],
  config: FontResolverConfig
): Promise<FontResolutionResult[]> {
  // Scan all font directories for available font files
  const availableFonts = await scanFontDirectories(config.fontDirs);

  // Load lookup table (optional)
  const lookupTable = await loadLookupTable(config.lookupTablePath);

  // Resolve each record
  const results: FontResolutionResult[] = [];
  for (const record of records) {
    const filePath = resolveFont(record, availableFonts, lookupTable);
    if (filePath === null) {
      console.warn(
        `Font resolver: could not resolve font "${record.family}" (weight: ${record.weight}, style: ${record.style})`
      );
    }
    results.push({ record, filePath });
  }

  return results;
}

/**
 * Scans font directories recursively for .ttf and .otf files.
 * Returns an array of absolute file paths.
 */
async function scanFontDirectories(fontDirs: string[]): Promise<string[]> {
  const fonts: string[] = [];

  for (const dir of fontDirs) {
    try {
      const entries = await readdir(dir, { recursive: true });
      for (const entry of entries) {
        const ext = path.extname(entry).toLowerCase();
        if (ext === '.ttf' || ext === '.otf') {
          fonts.push(path.resolve(dir, entry));
        }
      }
    } catch (err) {
      console.warn(`Font resolver: could not scan directory "${dir}":`, err);
    }
  }

  return fonts;
}

/**
 * Loads the optional lookup table JSON file.
 * Returns an empty map if the file is missing or malformed.
 */
async function loadLookupTable(
  lookupTablePath?: string
): Promise<Map<string, string>> {
  const table = new Map<string, string>();

  if (!lookupTablePath) {
    return table;
  }

  let content: string;
  try {
    content = await readFile(lookupTablePath, 'utf-8');
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      console.info(
        `Font resolver: lookup table not found at "${lookupTablePath}", using filename-only matching`
      );
    } else {
      console.warn(
        `Font resolver: could not read lookup table at "${lookupTablePath}":`, err
      );
    }
    return table;
  }

  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.warn(
        `Font resolver: lookup table at "${lookupTablePath}" is not a valid object, using filename-only matching`
      );
      return table;
    }

    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') {
        table.set(key, value);
      }
    }
  } catch (err) {
    console.warn(
      `Font resolver: malformed JSON in lookup table at "${lookupTablePath}", using filename-only matching`
    );
  }

  return table;
}

/**
 * Resolves a single font record to a file path.
 * Strategy: lookup table → case-insensitive filename match → variant selection
 */
function resolveFont(
  record: FontUsageRecord,
  availableFonts: string[],
  lookupTable: Map<string, string>
): string | null {
  // Step 1: Check lookup table for family→filename prefix mapping
  const lookupPrefix = lookupTable.get(record.family);
  if (lookupPrefix) {
    const match = findByPrefix(lookupPrefix, record, availableFonts);
    if (match) return match;
  }

  // Step 2: Case-insensitive matching against filenames
  const candidates = findCandidatesByFamily(record.family, availableFonts);
  if (candidates.length === 0) return null;

  // Step 3: Variant selection from candidates
  return selectBestVariant(candidates, record);
}

/**
 * Finds a font file by prefix from the lookup table.
 * Matches the prefix (normalized) against the filename base (normalized),
 * then selects the best variant.
 */
function findByPrefix(
  prefix: string,
  record: FontUsageRecord,
  availableFonts: string[]
): string | null {
  const normalizedPrefix = normalize(prefix);
  const candidates = availableFonts.filter((fontPath) => {
    const basename = path.basename(fontPath, path.extname(fontPath));
    const normalizedBasename = normalize(basename);
    return normalizedBasename.startsWith(normalizedPrefix);
  });

  if (candidates.length === 0) return null;
  return selectBestVariant(candidates, record);
}

/**
 * Finds candidate font files whose filename matches the font family name
 * using case-insensitive comparison after normalizing (removing spaces and hyphens).
 */
function findCandidatesByFamily(family: string, availableFonts: string[]): string[] {
  const normalizedFamily = normalize(family);

  return availableFonts.filter((fontPath) => {
    const basename = path.basename(fontPath, path.extname(fontPath));
    const normalizedBasename = normalize(basename);
    // The basename (without variant suffix) should start with or equal the family name
    return normalizedBasename.startsWith(normalizedFamily);
  });
}

/**
 * Selects the best variant from a list of candidate files based on
 * the requested weight and style.
 */
function selectBestVariant(
  candidates: string[],
  record: FontUsageRecord
): string | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const targetIndicator = getTargetIndicator(record.weight, record.style);

  // Score each candidate based on how well its variant indicator matches
  let bestCandidate: string | null = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, targetIndicator, record);
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

/**
 * Determines the target variant indicator for a given weight+style combination.
 */
function getTargetIndicator(
  weight: 'normal' | 'bold',
  style: 'normal' | 'italic'
): string {
  if (weight === 'bold' && style === 'italic') return 'bolditalic';
  if (weight === 'bold' && style === 'normal') return 'bold';
  if (weight === 'normal' && style === 'italic') return 'italic';
  return 'regular';
}

/**
 * Scores a candidate font file against the target variant.
 * Higher score = better match.
 */
function scoreCandidate(
  candidatePath: string,
  targetIndicator: string,
  record: FontUsageRecord
): number {
  const basename = path.basename(candidatePath, path.extname(candidatePath));
  const lowerBasename = basename.toLowerCase();

  // Extract variant part of the filename
  const variant = extractVariant(lowerBasename);

  // Exact match with target indicator
  if (variant === targetIndicator) return 100;

  // Handle Oblique as italic equivalent
  if (targetIndicator === 'italic' && variant === 'oblique') return 95;
  if (targetIndicator === 'bolditalic' && variant === 'boldoblique') return 95;

  // "Regular" or no variant indicator = normal weight + normal style
  if (targetIndicator === 'regular') {
    if (variant === '' || variant === 'regular') return 100;
    // Penalize variants that don't match
    return 0;
  }

  // No variant indicator in filename - could be the regular/base variant
  if (variant === '' || variant === 'regular') {
    if (targetIndicator === 'regular') return 100;
    // It's the base file but we want a specific variant - low score but not zero
    return 10;
  }

  // Partial match scenarios
  if (targetIndicator === 'bolditalic') {
    if (variant === 'bold') return 30;
    if (variant === 'italic' || variant === 'oblique') return 30;
  }

  return 0;
}

/**
 * Extracts the variant indicator from a filename (lowercase).
 * Recognizes: bold, italic, bolditalic, regular, oblique, boldoblique
 */
function extractVariant(lowerBasename: string): string {
  // Check for compound variants first (bolditalic, boldoblique)
  if (lowerBasename.endsWith('-bolditalic') || lowerBasename.endsWith('bolditalic')) {
    return 'bolditalic';
  }
  if (lowerBasename.endsWith('-boldoblique') || lowerBasename.endsWith('boldoblique')) {
    return 'boldoblique';
  }
  // Check single variants
  if (lowerBasename.endsWith('-bold') || lowerBasename.endsWith('bold')) {
    // Make sure it's not "bolditalic" which was already caught above
    return 'bold';
  }
  if (lowerBasename.endsWith('-italic') || lowerBasename.endsWith('italic')) {
    return 'italic';
  }
  if (lowerBasename.endsWith('-oblique') || lowerBasename.endsWith('oblique')) {
    return 'oblique';
  }
  if (lowerBasename.endsWith('-regular') || lowerBasename.endsWith('regular')) {
    return 'regular';
  }

  return '';
}

/**
 * Normalizes a string for comparison by removing spaces, hyphens,
 * and converting to lowercase.
 */
function normalize(str: string): string {
  return str.replace(/[\s\-]/g, '').toLowerCase();
}
