/**
 * Font Assignment Extractor - parses docx XML to produce ordered per-element
 * font assignments resolving the full style inheritance chain:
 *   docDefaults → named style → direct formatting
 */

import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

export interface RunAssignment {
  font: string;
  text: string;
}

export interface ParagraphAssignment {
  font: string;
  runs: RunAssignment[];
}

export interface FontAssignmentResult {
  bodyFont: string;
  paragraphs: ParagraphAssignment[];
}

interface StyleEntry {
  font: string | null;
  parentStyleId: string | null;
}

/**
 * Extracts per-element font assignments from a docx file.
 */
export async function extractFontAssignments(docxPath: string): Promise<FontAssignmentResult> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(docxPath);
  } catch (err) {
    console.warn('Font assignment extractor: failed to open docx:', err);
    return { bodyFont: 'serif', paragraphs: [] };
  }

  const stylesXml = readEntry(zip, 'word/styles.xml');
  const documentXml = readEntry(zip, 'word/document.xml');

  if (!documentXml) {
    console.warn('Font assignment extractor: missing word/document.xml');
    return { bodyFont: 'serif', paragraphs: [] };
  }

  // Parse styles
  let docDefaultFont = 'serif';
  const styleMap = new Map<string, StyleEntry>();
  let normalStyleId: string | null = null;

  if (stylesXml) {
    const parsed = parseXml(stylesXml);
    if (parsed) {
      docDefaultFont = extractDocDefault(parsed) ?? 'serif';
      buildStyleMap(parsed, styleMap);
      normalStyleId = findNormalStyleId(parsed);
    }
  }

  // Resolve body font: Normal style font → docDefault → "serif"
  let bodyFont = docDefaultFont;
  if (normalStyleId) {
    const normalFont = resolveStyleFont(normalStyleId, styleMap, docDefaultFont, 0);
    if (normalFont) bodyFont = normalFont;
  }

  // Parse document
  const docParsed = parseXml(documentXml);
  if (!docParsed) {
    return { bodyFont, paragraphs: [] };
  }

  const paragraphs = extractParagraphs(docParsed, styleMap, docDefaultFont, bodyFont);

  return { bodyFont, paragraphs };
}

function readEntry(zip: AdmZip, entryPath: string): string | null {
  const entry = zip.getEntry(entryPath);
  if (!entry) return null;
  return entry.getData().toString('utf-8');
}

function parseXml(xml: string): unknown | null {
  try {
    return xmlParser.parse(xml);
  } catch {
    return null;
  }
}

/**
 * Extracts the document default font from w:docDefaults/w:rPrDefault/w:rPr/w:rFonts.
 */
function extractDocDefault(parsed: unknown): string | null {
  const rFonts = getPath(parsed, [
    'w:styles', 'w:docDefaults', 'w:rPrDefault', 'w:rPr', 'w:rFonts',
  ]);
  return getFontFromRFonts(rFonts);
}

/**
 * Builds a map of styleId → { font, parentStyleId } from all w:style elements.
 * Also identifies the default paragraph style (Normal) by name or @w:default attribute.
 */
function buildStyleMap(parsed: unknown, styleMap: Map<string, StyleEntry>): void {
  const styles = getPath(parsed, ['w:styles', 'w:style']);
  if (!styles) return;

  for (const style of ensureArray(styles)) {
    if (!style || typeof style !== 'object') continue;
    const obj = style as Record<string, unknown>;
    const styleId = obj['@_w:styleId'];
    if (typeof styleId !== 'string') continue;

    const rFonts = getPath(obj, ['w:rPr', 'w:rFonts']);
    // Also check pPr/rPr for paragraph styles
    const pRFonts = getPath(obj, ['w:pPr', 'w:rPr', 'w:rFonts']);
    const font = getFontFromRFonts(rFonts) ?? getFontFromRFonts(pRFonts);

    const basedOn = getPath(obj, ['w:basedOn', '@_w:val']);
    const parentStyleId = typeof basedOn === 'string' ? basedOn : null;

    styleMap.set(styleId, { font, parentStyleId });
  }
}

/**
 * Finds the default paragraph style (Normal) styleId by looking for:
 * 1. A paragraph style with @w:default="1"
 * 2. A paragraph style named "Normal"
 */
function findNormalStyleId(parsed: unknown): string | null {
  const styles = getPath(parsed, ['w:styles', 'w:style']);
  if (!styles) return null;

  for (const style of ensureArray(styles)) {
    if (!style || typeof style !== 'object') continue;
    const obj = style as Record<string, unknown>;
    const type = obj['@_w:type'];
    if (type !== 'paragraph') continue;

    // Check @w:default="1"
    if (obj['@_w:default'] === '1' || obj['@_w:default'] === 1) {
      const id = obj['@_w:styleId'];
      if (typeof id === 'string') return id;
    }

    // Check name
    const name = getPath(obj, ['w:name', '@_w:val']);
    if (name === 'Normal') {
      const id = obj['@_w:styleId'];
      if (typeof id === 'string') return id;
    }
  }

  return null;
}

/**
 * Resolves a style's effective font by traversing the basedOn chain.
 * Returns null if no font is specified anywhere in the chain.
 */
function resolveStyleFont(
  styleId: string,
  styleMap: Map<string, StyleEntry>,
  docDefault: string,
  depth: number
): string | null {
  if (depth > 10) return null; // Cycle protection

  const entry = styleMap.get(styleId);
  if (!entry) return null;

  if (entry.font) return entry.font;

  if (entry.parentStyleId) {
    return resolveStyleFont(entry.parentStyleId, styleMap, docDefault, depth + 1);
  }

  return null;
}

/**
 * Extracts paragraphs from the parsed document.xml, resolving fonts via inheritance.
 */
function extractParagraphs(
  parsed: unknown,
  styleMap: Map<string, StyleEntry>,
  docDefault: string,
  bodyFont: string
): ParagraphAssignment[] {
  const body = getPath(parsed, ['w:document', 'w:body']);
  if (!body || typeof body !== 'object') return [];

  const paragraphs: ParagraphAssignment[] = [];
  collectParagraphs(body, styleMap, docDefault, bodyFont, paragraphs);
  return paragraphs;
}

/**
 * Recursively collects w:p elements from the document body (handles tables, etc.).
 */
function collectParagraphs(
  node: unknown,
  styleMap: Map<string, StyleEntry>,
  docDefault: string,
  bodyFont: string,
  out: ParagraphAssignment[]
): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;

  if ('w:p' in obj) {
    const paras = ensureArray(obj['w:p']);
    for (const p of paras) {
      const assignment = processParagraph(p, styleMap, docDefault, bodyFont);
      if (assignment) out.push(assignment);
    }
  }

  // Recurse into tables, structured elements, etc.
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'w:p') continue; // Already processed
    if (Array.isArray(value)) {
      for (const item of value) {
        collectParagraphs(item, styleMap, docDefault, bodyFont, out);
      }
    } else if (typeof value === 'object' && value !== null) {
      collectParagraphs(value, styleMap, docDefault, bodyFont, out);
    }
  }
}

/**
 * Processes a single w:p element into a ParagraphAssignment.
 * When no pStyle is specified, the paragraph implicitly uses the Normal (body) font.
 */
function processParagraph(
  p: unknown,
  styleMap: Map<string, StyleEntry>,
  docDefault: string,
  bodyFont: string
): ParagraphAssignment | null {
  if (!p || typeof p !== 'object') return null;
  const pObj = p as Record<string, unknown>;

  // Resolve paragraph-level font
  // Priority: direct pPr/rPr/rFonts > pStyle reference > bodyFont (implicit Normal)
  const pStyleId = getPath(pObj, ['w:pPr', 'w:pStyle', '@_w:val']) as string | undefined;
  const pDirectFont = getFontFromRFonts(getPath(pObj, ['w:pPr', 'w:rPr', 'w:rFonts']));

  // Start with the body font (which is the resolved Normal style font)
  let paraFont = bodyFont;
  if (pStyleId) {
    const styleFont = resolveStyleFont(pStyleId, styleMap, docDefault, 0);
    if (styleFont) paraFont = styleFont;
  }
  if (pDirectFont) paraFont = pDirectFont;

  // Process runs
  const runs: RunAssignment[] = [];
  const runElements = ensureArray(pObj['w:r']);

  for (const run of runElements) {
    if (!run || typeof run !== 'object') continue;
    const rObj = run as Record<string, unknown>;

    // Resolve run-level font
    // Priority: direct rPr/rFonts > rStyle reference > paragraph font
    const rStyleId = getPath(rObj, ['w:rPr', 'w:rStyle', '@_w:val']) as string | undefined;
    const rDirectFont = getFontFromRFonts(getPath(rObj, ['w:rPr', 'w:rFonts']));

    let runFont = paraFont;
    if (rStyleId) {
      const styleFont = resolveStyleFont(rStyleId, styleMap, docDefault, 0);
      if (styleFont) runFont = styleFont;
    }
    if (rDirectFont) runFont = rDirectFont;

    // Extract text
    const text = extractRunText(rObj);
    if (text.length > 0) {
      runs.push({ font: runFont, text });
    }
  }

  // Skip empty paragraphs (no runs with text)
  if (runs.length === 0) return null;

  return { font: paraFont, runs };
}

/**
 * Extracts text content from a run's w:t elements.
 * Treats w:br as a space separator.
 */
function extractRunText(run: Record<string, unknown>): string {
  // A run can contain interleaved w:t, w:br, w:tab, etc.
  // We need to handle the case where these are siblings in the run object.
  // fast-xml-parser may flatten them — check for both individual and mixed content.

  const parts: string[] = [];

  // Handle w:t
  const wt = run['w:t'];
  if (wt !== undefined && wt !== null) {
    parts.push(extractTextValue(wt));
  }

  // Handle w:br — if present, insert a space between text segments
  // But the real issue is that fast-xml-parser may merge sibling elements.
  // With the parser config we have, w:t and w:br are separate keys.
  // If w:br exists and w:t is an array, the text was split by a break.
  if (run['w:br'] !== undefined) {
    // Insert space in the middle of text if we have it
    // Since fast-xml-parser puts all w:t content together, we need to check
    // if the text should have a space inserted.
    // Actually, when w:br exists between w:t elements, fast-xml-parser
    // may combine the w:t values into an array.
    // We already handle arrays in extractTextValue, but we need to add
    // a space between array items when w:br is present.
    if (Array.isArray(wt) && wt.length > 1) {
      // Re-extract with space separator
      return wt.map(t => {
        if (typeof t === 'string') return t;
        if (typeof t === 'number') return String(t);
        if (typeof t === 'object' && t !== null) {
          const text = (t as Record<string, unknown>)['#text'];
          if (typeof text === 'string') return text;
          if (typeof text === 'number') return String(text);
        }
        return '';
      }).join(' ');
    }
  }

  if (parts.length > 0) return parts.join('');

  return '';
}

/**
 * Extracts text from a w:t value (handles string, number, object with #text, and arrays).
 */
function extractTextValue(wt: unknown): string {
  if (typeof wt === 'string') return wt;
  if (typeof wt === 'number') return String(wt);

  if (typeof wt === 'object' && !Array.isArray(wt) && wt !== null) {
    const obj = wt as Record<string, unknown>;
    const text = obj['#text'];
    if (typeof text === 'string') return text;
    if (typeof text === 'number') return String(text);
    return '';
  }

  if (Array.isArray(wt)) {
    return wt.map(t => {
      if (typeof t === 'string') return t;
      if (typeof t === 'number') return String(t);
      if (typeof t === 'object' && t !== null) {
        const text = (t as Record<string, unknown>)['#text'];
        if (typeof text === 'string') return text;
        if (typeof text === 'number') return String(text);
      }
      return '';
    }).join('');
  }

  return '';
}

/**
 * Extracts font family from w:rFonts attributes.
 * Prioritizes @w:ascii, falls back to @w:hAnsi.
 */
function getFontFromRFonts(rFonts: unknown): string | null {
  if (!rFonts || typeof rFonts !== 'object') return null;
  const obj = rFonts as Record<string, unknown>;
  const ascii = obj['@_w:ascii'];
  if (typeof ascii === 'string' && ascii.trim()) return ascii.trim();
  const hAnsi = obj['@_w:hAnsi'];
  if (typeof hAnsi === 'string' && hAnsi.trim()) return hAnsi.trim();
  return null;
}

/**
 * Safely traverses nested properties.
 */
function getPath(obj: unknown, path: string[]): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function ensureArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}
