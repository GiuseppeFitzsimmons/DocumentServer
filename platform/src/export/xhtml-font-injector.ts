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

  // Build lookup: only paragraphs with non-body fonts need injection
  const nonBodyParas = paragraphs.filter(
    p => p.runs.some(r => r.font !== bodyFont)
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
 * Only handles the simple case where all runs in a paragraph share the same font.
 */
function buildFontMap(
  nonBodyParas: ParagraphAssignment[],
  bodyFont: string
): Map<string, FontMapEntry> {
  const map = new Map<string, FontMapEntry>();

  for (const para of nonBodyParas) {
    const fonts = new Set(para.runs.map(r => r.font));

    // Only handle uniform-font paragraphs for now
    if (fonts.size === 1) {
      const font = para.runs[0].font;
      if (font === bodyFont) continue;

      const text = normalizeText(para.runs.map(r => r.text).join(''));
      if (text.length > 0) {
        map.set(text, { font });
      }
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
 * and injecting font-family styles where needed.
 */
function injectFontsIntoXhtml(
  content: string,
  fontMap: Map<string, FontMapEntry>
): InjectResult {
  let modified = false;

  const result = content.replace(BLOCK_REGEX, (match, openTag: string, inner: string, closeTag: string) => {
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
