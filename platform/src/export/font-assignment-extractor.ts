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
  trimValues: false,
});

export interface RunAssignment {
  font: string;
  text: string;
}

export interface BorderDef {
  style: string;    // CSS border-style (solid, dashed, dotted, double, none)
  color: string;    // hex color
  width: number;    // in pt (from w:sz / 8)
}

export interface ParagraphStyle {
  textAlign?: 'left' | 'center' | 'right' | 'justify';
  lineHeight?: number;      // in points (from w:spacing w:line / 240 * 12)
  spaceBefore?: number;     // in points (from w:spacing w:before in twips / 20)
  spaceAfter?: number;      // in points
  textIndent?: number;      // in points (first line indent, from w:ind w:firstLine in twips / 20)
  marginLeft?: number;      // in points (from w:ind w:left in twips / 20)
  marginRight?: number;     // in points
  fontSize?: number;        // in points (from w:sz / 2, half-points)
  borderTop?: BorderDef;
  borderBottom?: BorderDef;
  borderLeft?: BorderDef;
  borderRight?: BorderDef;
}

export interface ParagraphAssignment {
  font: string;
  runs: RunAssignment[];
  headingLevel?: number;  // 1-9 if heading, undefined for body paragraphs
  style?: ParagraphStyle;
}

export interface FontAssignmentResult {
  bodyFont: string;
  paragraphs: ParagraphAssignment[];
  headingFonts: Map<number, string>;  // heading level → most common font for that level
}

interface StyleEntry {
  font: string | null;
  parentStyleId: string | null;
  pPr?: Record<string, unknown>;  // Raw paragraph properties from the style definition
  rPr?: Record<string, unknown>;  // Raw run properties from the style definition
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
    return { bodyFont: 'serif', paragraphs: [], headingFonts: new Map() };
  }

  const stylesXml = readEntry(zip, 'word/styles.xml');
  const documentXml = readEntry(zip, 'word/document.xml');

  if (!documentXml) {
    console.warn('Font assignment extractor: missing word/document.xml');
    return { bodyFont: 'serif', paragraphs: [], headingFonts: new Map() };
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

  // Extract document default font size (from w:docDefaults/w:rPrDefault/w:rPr/w:sz)
  let docDefaultFontSize: number | undefined;
  if (stylesXml) {
    const parsed = parseXml(stylesXml);
    if (parsed) {
      const szVal = getPath(parsed, ['w:styles', 'w:docDefaults', 'w:rPrDefault', 'w:rPr', 'w:sz', '@_w:val']);
      if (szVal !== undefined) {
        const val = Number(szVal);
        if (!isNaN(val)) docDefaultFontSize = val / 2; // half-points to points
      }
    }
  }

  // Build heading style map (styleId → heading level)
  const headingStyleMap = buildHeadingStyleMap(styleMap, stylesXml);

  // Resolve body font: Normal style font → docDefault → "serif"
  let bodyFont = docDefaultFont;
  if (normalStyleId) {
    const normalFont = resolveStyleFont(normalStyleId, styleMap, docDefaultFont, 0);
    if (normalFont) bodyFont = normalFont;
  }

  // Parse document
  const docParsed = parseXml(documentXml);
  if (!docParsed) {
    return { bodyFont, paragraphs: [], headingFonts: new Map() };
  }

  const paragraphs = extractParagraphs(docParsed, styleMap, docDefaultFont, bodyFont, headingStyleMap, docDefaultFontSize);

  // Compute per-level heading fonts
  const headingFonts = computeHeadingFonts(paragraphs);

  return { bodyFont, paragraphs, headingFonts };
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

    // Store paragraph properties from the style definition
    const pPr = obj['w:pPr'] as Record<string, unknown> | undefined;
    // Store run properties from the style definition (for font-size inheritance)
    const rPr = obj['w:rPr'] as Record<string, unknown> | undefined;

    styleMap.set(styleId, { font, parentStyleId, pPr: pPr || undefined, rPr: rPr || undefined });
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
  bodyFont: string,
  headingStyleMap: Map<string, number>,
  docDefaultFontSize?: number
): ParagraphAssignment[] {
  const body = getPath(parsed, ['w:document', 'w:body']);
  if (!body || typeof body !== 'object') return [];

  const paragraphs: ParagraphAssignment[] = [];
  collectParagraphs(body, styleMap, docDefault, bodyFont, headingStyleMap, paragraphs, docDefaultFontSize);
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
  headingStyleMap: Map<string, number>,
  out: ParagraphAssignment[],
  docDefaultFontSize?: number
): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;

  if ('w:p' in obj) {
    const paras = ensureArray(obj['w:p']);
    for (const p of paras) {
      const assignment = processParagraph(p, styleMap, docDefault, bodyFont, headingStyleMap, docDefaultFontSize);
      if (assignment) out.push(assignment);
    }
  }

  // Recurse into tables, structured elements, etc.
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'w:p') continue; // Already processed
    if (Array.isArray(value)) {
      for (const item of value) {
        collectParagraphs(item, styleMap, docDefault, bodyFont, headingStyleMap, out, docDefaultFontSize);
      }
    } else if (typeof value === 'object' && value !== null) {
      collectParagraphs(value, styleMap, docDefault, bodyFont, headingStyleMap, out, docDefaultFontSize);
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
  bodyFont: string,
  headingStyleMap: Map<string, number>,
  docDefaultFontSize?: number
): ParagraphAssignment | null {
  if (!p || typeof p !== 'object') return null;
  const pObj = p as Record<string, unknown>;

  // Resolve paragraph-level font
  // Priority: direct pPr/rPr/rFonts > pStyle reference > bodyFont (implicit Normal)
  const pStyleId = getPath(pObj, ['w:pPr', 'w:pStyle', '@_w:val']) as string | undefined;
  const pDirectFont = getFontFromRFonts(getPath(pObj, ['w:pPr', 'w:rPr', 'w:rFonts']));

  // Detect heading level from style
  const headingLevel = pStyleId ? headingStyleMap.get(pStyleId) : undefined;

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

  // Extract paragraph style properties (including inherited from named style)
  const style = extractParagraphStyle(pObj, pStyleId, styleMap, docDefaultFontSize);

  return { font: paraFont, runs, headingLevel, style };
}

/**
 * Extracts paragraph-level style properties from w:pPr.
 * Falls back to the named style's pPr for properties not directly set.
 */
function extractParagraphStyle(
  pObj: Record<string, unknown>,
  pStyleId: string | undefined,
  styleMap: Map<string, StyleEntry>,
  docDefaultFontSize?: number
): ParagraphStyle | undefined {
  const pPr = pObj['w:pPr'];
  const pPrObj = (pPr && typeof pPr === 'object') ? pPr as Record<string, unknown> : undefined;

  // Get the style's pPr as fallback
  const stylePPr = pStyleId ? resolveStylePPr(pStyleId, styleMap, 0) : undefined;

  const style: ParagraphStyle = {};
  let hasAny = false;

  // text-align from w:jc (direct first, then style chain)
  const jcDirect = pPrObj ? getPath(pPrObj, ['w:jc', '@_w:val']) : undefined;
  let jc = jcDirect;
  if (!jc && pStyleId) {
    // Traverse the full basedOn chain for w:jc
    jc = resolveStyleProperty(pStyleId, styleMap, ['w:jc', '@_w:val'], 0);
  }
  if (jc && typeof jc === 'string') {
    const alignMap: Record<string, ParagraphStyle['textAlign']> = {
      left: 'left', start: 'left',
      center: 'center',
      right: 'right', end: 'right',
      both: 'justify', distribute: 'justify',
    };
    if (alignMap[jc]) { style.textAlign = alignMap[jc]; hasAny = true; }
  }

  // spacing: line-height, space before/after (direct first, then style)
  const spacing = (pPrObj ? pPrObj['w:spacing'] : undefined) ??
                  (stylePPr ? stylePPr['w:spacing'] : undefined);
  if (spacing && typeof spacing === 'object') {
    const spacingObj = spacing as Record<string, unknown>;
    const line = spacingObj['@_w:line'];
    const lineRule = spacingObj['@_w:lineRule'] as string | undefined;
    if (line !== undefined) {
      const lineVal = Number(line);
      if (!isNaN(lineVal)) {
        if (!lineRule || lineRule === 'auto') {
          style.lineHeight = Math.round((lineVal / 240) * 100) / 100;
        } else {
          style.lineHeight = lineVal / 20;
        }
        hasAny = true;
      }
    }
    const before = spacingObj['@_w:before'];
    if (before !== undefined) {
      const val = Number(before);
      if (!isNaN(val)) { style.spaceBefore = val / 20; hasAny = true; }
    }
    const after = spacingObj['@_w:after'];
    if (after !== undefined) {
      const val = Number(after);
      if (!isNaN(val)) { style.spaceAfter = val / 20; hasAny = true; }
    }
  }

  // indentation (direct first, then style)
  const ind = (pPrObj ? pPrObj['w:ind'] : undefined) ??
              (stylePPr ? stylePPr['w:ind'] : undefined);
  if (ind && typeof ind === 'object') {
    const indObj = ind as Record<string, unknown>;
    const firstLine = indObj['@_w:firstLine'];
    if (firstLine !== undefined) {
      const val = Number(firstLine);
      if (!isNaN(val)) { style.textIndent = val / 20; hasAny = true; }
    }
    const left = indObj['@_w:left'] ?? indObj['@_w:start'];
    if (left !== undefined) {
      const val = Number(left);
      if (!isNaN(val)) { style.marginLeft = val / 20; hasAny = true; }
    }
    const right = indObj['@_w:right'] ?? indObj['@_w:end'];
    if (right !== undefined) {
      const val = Number(right);
      if (!isNaN(val)) { style.marginRight = val / 20; hasAny = true; }
    }
  }

  // font-size: direct pPr/rPr/w:sz → style chain rPr/w:sz (no document default fallback)
  let sz = pPrObj ? getPath(pPrObj, ['w:rPr', 'w:sz', '@_w:val']) : undefined;
  const szSource = sz !== undefined ? 'direct' : undefined;
  if (sz === undefined && pStyleId) {
    sz = resolveStyleProperty(pStyleId, styleMap, ['w:rPr', 'w:sz', '@_w:val'], 0);
    if (sz !== undefined) {
      // found in pPr/rPr of style chain
    } else {
      sz = resolveStyleRprProperty(pStyleId, styleMap, ['w:sz', '@_w:val'], 0);
    }
  }
  if (sz !== undefined) {
    const val = Number(sz);
    if (!isNaN(val)) {
      style.fontSize = val / 2;
      hasAny = true;
      console.log(`[font-size] Found: ${val / 2}pt, pStyleId=${pStyleId || 'none'}, source=${szSource || 'style-chain'}`);
    }
  }

  // Borders from w:pBdr (direct first, then style)
  // Note: fast-xml-parser may produce "" for empty elements like <w:pBdr/>, use || for fallback
  const directPBdr = pPrObj ? pPrObj['w:pBdr'] : undefined;
  const pBdr = (directPBdr && typeof directPBdr === 'object') ? directPBdr :
               (stylePPr ? stylePPr['w:pBdr'] : undefined);
  if (pBdr && typeof pBdr === 'object') {
    const bdrObj = pBdr as Record<string, unknown>;
    const sides = ['top', 'bottom', 'left', 'right'] as const;
    for (const side of sides) {
      const border = parseBorder(bdrObj[`w:${side}`]);
      if (border) {
        style[`border${side.charAt(0).toUpperCase()}${side.slice(1)}` as keyof ParagraphStyle] = border as any;
        hasAny = true;
      }
    }
  }

  return hasAny ? style : undefined;
}

/**
 * Parses a border element (w:top, w:bottom, etc.) into a BorderDef.
 */
function parseBorder(borderEl: unknown): BorderDef | null {
  if (!borderEl || typeof borderEl !== 'object') return null;
  const obj = borderEl as Record<string, unknown>;

  const val = obj['@_w:val'] as string | undefined;
  if (!val || val === 'none' || val === 'nil') return null;

  const sz = Number(obj['@_w:sz'] || 0);
  const color = (obj['@_w:color'] as string) || '000000';

  // w:sz is in eighths of a point
  const widthPt = Math.max(sz / 8, 0.5);

  // Map OOXML border styles to CSS
  const styleMap: Record<string, string> = {
    single: 'solid',
    thick: 'solid',
    double: 'double',
    dotted: 'dotted',
    dashed: 'dashed',
    dashSmallGap: 'dashed',
    dotDash: 'dashed',
    dotDotDash: 'dotted',
    triple: 'double',
    wave: 'solid',
  };

  return {
    style: styleMap[val] || 'solid',
    color: color === 'auto' ? '000000' : color,
    width: widthPt,
  };
}

/**
 * Resolves a specific property from a style's rPr by traversing the basedOn chain.
 * Used for font-size which is stored in the style's rPr (not inside pPr).
 */
function resolveStyleRprProperty(
  styleId: string,
  styleMap: Map<string, StyleEntry>,
  propertyPath: string[],
  depth: number
): unknown {
  if (depth > 10) return undefined;
  const entry = styleMap.get(styleId);
  if (!entry) return undefined;

  if (entry.rPr) {
    const value = getPath(entry.rPr, propertyPath);
    if (value !== undefined) return value;
  }

  if (entry.parentStyleId) {
    return resolveStyleRprProperty(entry.parentStyleId, styleMap, propertyPath, depth + 1);
  }

  return undefined;
}

/**
 * Resolves a specific property from a style's pPr by traversing the basedOn chain.
 * Unlike resolveStylePPr which stops at the first pPr found, this looks for a
 * specific property path within pPr through the entire chain.
 */
function resolveStyleProperty(
  styleId: string,
  styleMap: Map<string, StyleEntry>,
  propertyPath: string[],
  depth: number
): unknown {
  if (depth > 10) return undefined;
  const entry = styleMap.get(styleId);
  if (!entry) return undefined;

  if (entry.pPr) {
    const value = getPath(entry.pPr, propertyPath);
    if (value !== undefined) return value;
  }

  if (entry.parentStyleId) {
    return resolveStyleProperty(entry.parentStyleId, styleMap, propertyPath, depth + 1);
  }

  return undefined;
}

/**
 * Resolves a style's paragraph properties by traversing the basedOn chain.
 */
function resolveStylePPr(
  styleId: string,
  styleMap: Map<string, StyleEntry>,
  depth: number
): Record<string, unknown> | undefined {
  if (depth > 10) return undefined;
  const entry = styleMap.get(styleId);
  if (!entry) return undefined;
  if (entry.pPr) return entry.pPr;
  if (entry.parentStyleId) return resolveStylePPr(entry.parentStyleId, styleMap, depth + 1);
  return undefined;
}

/**
 * Extracts text content from a run's w:t elements.
 * Treats w:br as a space (soft return = visual line break = word separator).
 */
function extractRunText(run: Record<string, unknown>): string {
  const wt = run['w:t'];
  const hasBr = run['w:br'] !== undefined;

  if (wt === undefined || wt === null) return '';

  if (hasBr && Array.isArray(wt) && wt.length > 1) {
    // Multiple w:t elements with a w:br between them — join with space
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

  // Single w:t (or no br) — extract normally
  const text = extractTextValue(wt);

  // If there's a br but only one w:t, add a trailing space
  // (the br represents a break after this text segment)
  if (hasBr && text.length > 0) return text + ' ';

  return text;

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

/**
 * Builds a styleId → heading level map by inspecting style names.
 * OnlyOffice uses numeric style IDs with names like "heading 1".
 */
function buildHeadingStyleMap(styleMap: Map<string, StyleEntry>, stylesXml: string | null): Map<string, number> {
  const headingStyleMap = new Map<string, number>();
  if (!stylesXml) return headingStyleMap;

  const parsed = parseXml(stylesXml);
  if (!parsed) return headingStyleMap;

  const styles = getPath(parsed, ['w:styles', 'w:style']);
  if (!styles) return headingStyleMap;

  for (const style of ensureArray(styles)) {
    if (!style || typeof style !== 'object') continue;
    const obj = style as Record<string, unknown>;
    const styleId = obj['@_w:styleId'];
    if (typeof styleId !== 'string') continue;

    const styleName = getPath(obj, ['w:name', '@_w:val']);
    if (typeof styleName !== 'string') continue;

    const match = styleName.match(/^heading\s*(\d)$/i);
    if (match) {
      headingStyleMap.set(styleId, parseInt(match[1], 10));
    }
  }

  return headingStyleMap;
}

/**
 * Computes the most common font for each heading level.
 * Uses the effective paragraph font (which accounts for direct formatting overrides).
 */
function computeHeadingFonts(paragraphs: ParagraphAssignment[]): Map<number, string> {
  const levelFontCounts = new Map<number, Map<string, number>>();

  for (const para of paragraphs) {
    if (!para.headingLevel) continue;

    // Use the paragraph font — this correctly reflects direct formatting overrides
    const font = para.font;
    if (!font) continue;

    let fontCounts = levelFontCounts.get(para.headingLevel);
    if (!fontCounts) {
      fontCounts = new Map();
      levelFontCounts.set(para.headingLevel, fontCounts);
    }
    fontCounts.set(font, (fontCounts.get(font) ?? 0) + 1);
  }

  const result = new Map<number, string>();
  for (const [level, fontCounts] of levelFontCounts) {
    let maxFont = '';
    let maxCount = 0;
    for (const [font, count] of fontCounts) {
      if (count > maxCount) {
        maxFont = font;
        maxCount = count;
      }
    }
    if (maxFont) result.set(level, maxFont);
  }

  return result;
}
