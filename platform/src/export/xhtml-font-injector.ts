/**
 * XHTML Font Injector - post-processes pandoc-generated XHTML within an epub
 * to inject per-element font-family inline styles based on font assignments
 * extracted from the source docx.
 *
 * Uses text-content matching to correlate docx paragraphs to XHTML block
 * elements, which is robust against pandoc inserting synthetic pages (ToC,
 * title page) that have no docx counterpart.
 */

import AdmZip from 'adm-zip';
import { writeFileSync } from 'fs';
import type { FontAssignmentResult, ParagraphAssignment } from './font-assignment-extractor.js';

export interface XhtmlFontInjectorInput {
  epubPath: string;
  assignments: FontAssignmentResult;
}

/**
 * Injects font-family inline styles into XHTML content files within the epub.
 * Uses text-content matching to correlate paragraphs to XHTML elements.
 */
export async function injectXhtmlFonts(input: XhtmlFontInjectorInput): Promise<void> {
  const { epubPath, assignments } = input;
  const { bodyFont, paragraphs } = assignments;

  if (paragraphs.length === 0) return;

  // Build lookup: paragraphs with non-body fonts (either run-level or para-level)
  const nonBodyParas = paragraphs.filter(
    p => p.font !== bodyFont || p.runs.some(r => r.font !== bodyFont)
  );
  if (nonBodyParas.length === 0) return;

  // Build a map of normalized text → font for fast lookup
  const fontMap = buildFontMap(nonBodyParas, bodyFont);

  let zip: AdmZip;
  try {
    zip = new AdmZip(epubPath);
  } catch (err) {
    throw new Error(`XHTML font injector: failed to open epub: ${err}`);
  }

  const xhtmlEntries = findXhtmlFiles(zip);
  if (xhtmlEntries.length === 0) {
    console.warn('XHTML font injector: no XHTML files found in epub');
    return;
  }

  let modified = false;

  for (const entryName of xhtmlEntries) {
    const entry = zip.getEntry(entryName);
    if (!entry) continue;

    const content = entry.getData().toString('utf-8');
    const result = injectFontsIntoXhtml(content, fontMap);

    if (result.modified) {
      zip.updateFile(entryName, Buffer.from(result.content, 'utf-8'));
      modified = true;
    }
  }

  if (modified) {
    writeFileSync(epubPath, zip.toBuffer());
  }
}

interface FontMapEntry {
  font: string;       // The uniform font for this paragraph (when all runs share same font)
}

/**
 * Builds a map of normalized paragraph text → font for non-body-font paragraphs.
 * Handles two cases:
 * 1. All runs share the same font (different from body) → use that font
 * 2. Paragraph-level font differs from body (heading with override) → use para font
 */
function buildFontMap(
  nonBodyParas: ParagraphAssignment[],
  bodyFont: string
): Map<string, FontMapEntry> {
  const map = new Map<string, FontMapEntry>();

  for (const para of nonBodyParas) {
    const text = normalizeText(para.runs.map(r => r.text).join(''));
    if (text.length === 0) continue;

    // Case 1: All runs share the same non-body font
    const fonts = new Set(para.runs.map(r => r.font));
    if (fonts.size === 1) {
      const font = para.runs[0].font;
      if (font !== bodyFont) {
        map.set(text, { font });
        continue;
      }
    }

    // Case 2: Paragraph font is non-body (e.g. heading with style-level font)
    if (para.font && para.font !== bodyFont) {
      map.set(text, { font: para.font });
    }
  }

  return map;
}

/**
 * Finds XHTML content files, excluding nav pages.
 */
function findXhtmlFiles(zip: AdmZip): string[] {
  return zip.getEntries()
    .filter(e => {
      if (e.isDirectory) return false;
      if (!/\.(xhtml|html)$/.test(e.entryName)) return false;
      if (e.entryName.toLowerCase().includes('nav')) return false;
      return true;
    })
    .map(e => e.entryName)
    .sort();
}

// Matches block-level elements in pandoc XHTML output
const BLOCK_REGEX = /(<(?:p|h[1-6]|li|blockquote|div)\b[^>]*>)([\s\S]*?)(<\/(?:p|h[1-6]|li|blockquote|div)>)/gi;

interface InjectResult {
  content: string;
  modified: boolean;
}

/**
 * Processes a single XHTML file, matching block elements by text content
 * and injecting font-family styles where needed. Also strips pandoc's
 * inline font-size (pt) and line-height (absolute) declarations.
 */
function injectFontsIntoXhtml(
  content: string,
  fontMap: Map<string, FontMapEntry>
): InjectResult {
  let modified = false;

  let result = content.replace(BLOCK_REGEX, (match, openTag: string, inner: string, closeTag: string) => {
    // Extract text content from this block element
    const textContent = normalizeText(stripHtmlTags(inner));
    if (textContent.length === 0) return match;

    // Look up in font map
    const entry = fontMap.get(textContent);
    if (!entry) return match;

    modified = true;

    // Apply font-family to the block element
    const styledTag = injectStyleOnTag(openTag, `font-family: '${entry.font}'`);
    return styledTag + inner + closeTag;
  });

  // Strip pandoc-injected absolute font-size and line-height from inline styles
  const cleaned = stripAbsoluteInlineStyles(result);
  if (cleaned !== result) {
    result = cleaned;
    modified = true;
  }

  return { content: result, modified };
}

/**
 * Injects a CSS style property into an opening HTML tag.
 * Appends to existing style attribute if present.
 */
function injectStyleOnTag(openTag: string, style: string): string {
  const styleAttrRegex = /style="([^"]*)"/i;
  const existing = openTag.match(styleAttrRegex);

  if (existing) {
    const existingStyle = existing[1].trim();
    const separator = existingStyle.endsWith(';') || existingStyle === '' ? '' : '; ';
    const newStyle = existingStyle + separator + style;
    return openTag.replace(styleAttrRegex, `style="${newStyle}"`);
  }

  return openTag.replace(/>$/, ` style="${style}">`);
}

/**
 * Strips HTML tags from a string, returning only text content.
 */
function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

/**
 * Normalizes text for comparison: collapse whitespace, trim, lowercase.
 */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Strips pandoc-injected absolute font-size and line-height declarations from
 * inline style attributes. These override our CSS rules and produce wrong sizing.
 * Our epub-styles.css defines correct relative sizes (em, %) for all elements.
 */
function stripAbsoluteInlineStyles(content: string): string {
  // Remove font-size in pt/px from style attributes
  let result = content.replace(/font-size:\s*[\d.]+(?:pt|px)\s*;?\s*/gi, '');
  // Remove line-height in pt/px from style attributes
  result = result.replace(/line-height:\s*[\d.]+(?:pt|px)\s*;?\s*/gi, '');
  // Clean up empty or whitespace-only style attributes
  result = result.replace(/\s*style="\s*;?\s*"/gi, '');
  return result;
}
