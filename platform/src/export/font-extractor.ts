/**
 * Font Extractor - parses docx XML to identify font usage.
 *
 * Extracts font family names and their style variants (weight, style)
 * from word/styles.xml and word/document.xml within a docx archive.
 */

import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import type { FontUsageRecord } from './font-types.js';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

/**
 * Extracts all font usage records from a docx file.
 * Parses both word/styles.xml and word/document.xml to find font references.
 *
 * @param docxPath - Absolute path to the .docx file
 * @returns Deduplicated list of FontUsageRecords found in the document
 */
export async function extractFontsFromDocx(docxPath: string): Promise<FontUsageRecord[]> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(docxPath);
  } catch (err) {
    console.warn(`Font extractor: failed to open docx archive at ${docxPath}:`, err);
    return [];
  }

  const records: FontUsageRecord[] = [];

  const stylesXml = readZipEntry(zip, 'word/styles.xml');
  const documentXml = readZipEntry(zip, 'word/document.xml');

  if (stylesXml === null && documentXml === null) {
    console.warn('Font extractor: docx is missing both word/styles.xml and word/document.xml');
    return [];
  }

  if (stylesXml !== null) {
    const parsed = parseXmlSafe(stylesXml, 'word/styles.xml');
    if (parsed !== null) {
      extractFromStyles(parsed, records);
    }
  }

  if (documentXml !== null) {
    const parsed = parseXmlSafe(documentXml, 'word/document.xml');
    if (parsed !== null) {
      extractFromDocument(parsed, records);
    }
  }

  return deduplicateRecords(records);
}

/**
 * Reads a zip entry as a UTF-8 string.
 * Returns null if the entry does not exist.
 */
function readZipEntry(zip: AdmZip, entryPath: string): string | null {
  const entry = zip.getEntry(entryPath);
  if (!entry) {
    return null;
  }
  const buffer = entry.getData();
  return buffer.toString('utf-8');
}

/**
 * Safely parses XML content. Returns null and logs a warning if parsing fails.
 */
function parseXmlSafe(xml: string, source: string): unknown {
  try {
    return xmlParser.parse(xml);
  } catch (err) {
    console.warn(`Font extractor: failed to parse ${source}:`, err);
    return null;
  }
}

/**
 * Extracts font usage from word/styles.xml.
 * Looks at w:style/w:rPr for style-level font definitions.
 */
function extractFromStyles(parsed: unknown, records: FontUsageRecord[]): void {
  const styles = getNestedValue(parsed, ['w:styles', 'w:style']);
  if (!styles) return;

  const styleList = ensureArray(styles);
  for (const style of styleList) {
    const rPr = getNestedValue(style, ['w:rPr']);
    if (rPr) {
      extractFromRunProperties(rPr, records);
    }
  }
}

/**
 * Extracts font usage from word/document.xml.
 * Traverses the document body looking for w:r/w:rPr elements.
 */
function extractFromDocument(parsed: unknown, records: FontUsageRecord[]): void {
  const body = getNestedValue(parsed, ['w:document', 'w:body']);
  if (!body) return;

  collectRunProperties(body, records);
}

/**
 * Recursively traverses an object looking for w:rPr elements within w:r runs.
 */
function collectRunProperties(node: unknown, records: FontUsageRecord[]): void {
  if (node === null || node === undefined || typeof node !== 'object') return;

  const obj = node as Record<string, unknown>;

  // Check for run properties directly in runs
  if ('w:r' in obj) {
    const runs = ensureArray(obj['w:r']);
    for (const run of runs) {
      const rPr = getNestedValue(run, ['w:rPr']);
      if (rPr) {
        extractFromRunProperties(rPr, records);
      }
    }
  }

  // Recurse into all object values to find nested paragraphs, tables, etc.
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        collectRunProperties(item, records);
      }
    } else if (typeof value === 'object' && value !== null) {
      collectRunProperties(value, records);
    }
  }
}

/**
 * Extracts font records from a single w:rPr element.
 * Reads w:rFonts attributes for family names and w:b/w:i for weight/style.
 */
function extractFromRunProperties(rPr: unknown, records: FontUsageRecord[]): void {
  if (rPr === null || rPr === undefined || typeof rPr !== 'object') return;

  const rPrObj = rPr as Record<string, unknown>;
  const rFonts = rPrObj['w:rFonts'];
  if (!rFonts || typeof rFonts !== 'object') return;

  const rFontsObj = rFonts as Record<string, unknown>;

  // Collect unique font families from w:ascii, w:hAnsi, w:cs attributes
  const families = new Set<string>();
  const attrKeys = ['@_w:ascii', '@_w:hAnsi', '@_w:cs'];
  for (const key of attrKeys) {
    const value = rFontsObj[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      families.add(value.trim());
    }
  }

  if (families.size === 0) return;

  // Determine weight and style from sibling elements
  const weight = isBold(rPrObj) ? 'bold' : 'normal';
  const style = isItalic(rPrObj) ? 'italic' : 'normal';

  for (const family of families) {
    records.push({ family, weight, style });
  }
}

/**
 * Checks if the w:b element indicates bold formatting.
 * The element's mere presence indicates bold, unless w:val="false" or w:val="0".
 */
function isBold(rPr: Record<string, unknown>): boolean {
  return isFormattingActive(rPr, 'w:b');
}

/**
 * Checks if the w:i element indicates italic formatting.
 * The element's mere presence indicates italic, unless w:val="false" or w:val="0".
 */
function isItalic(rPr: Record<string, unknown>): boolean {
  return isFormattingActive(rPr, 'w:i');
}

/**
 * Checks if a boolean formatting element (w:b, w:i) is active.
 * In OOXML, presence of the element means "on" unless val="false" or val="0".
 */
function isFormattingActive(rPr: Record<string, unknown>, elementName: string): boolean {
  const element = rPr[elementName];
  if (element === undefined || element === null) return false;

  // Element present with no attributes (self-closing tag) means active
  if (element === '' || element === true) return true;

  // Check for explicit val attribute
  if (typeof element === 'object') {
    const val = (element as Record<string, unknown>)['@_w:val'];
    if (val === 'false' || val === '0' || val === false) return false;
    return true;
  }

  return true;
}

/**
 * Deduplicates font usage records by family+weight+style combination.
 */
function deduplicateRecords(records: FontUsageRecord[]): FontUsageRecord[] {
  const seen = new Set<string>();
  const result: FontUsageRecord[] = [];

  for (const record of records) {
    const key = `${record.family}|${record.weight}|${record.style}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(record);
    }
  }

  return result;
}

/**
 * Safely traverses nested properties in a parsed XML object.
 */
function getNestedValue(obj: unknown, path: string[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Ensures a value is an array. If it's already an array, returns it as-is.
 * Otherwise wraps it in an array. This handles XML elements that can be
 * either a single object or an array depending on how many exist.
 */
function ensureArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}
