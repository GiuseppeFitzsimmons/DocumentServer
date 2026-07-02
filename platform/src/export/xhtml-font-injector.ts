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
import { SECTION_BREAK_MARKER } from './docx-preprocessor.js';

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
  font: string;
}

/**
 * Builds a map of normalized paragraph text → font for non-body-font paragraphs.
 */
function buildFontMap(
  nonBodyParas: ParagraphAssignment[],
  bodyFont: string
): Map<string, FontMapEntry> {
  const map = new Map<string, FontMapEntry>();

  for (const para of nonBodyParas) {
    const text = normalizeText(para.runs.map(r => r.text).join(''));
    if (text.length === 0) continue;

    const fonts = new Set(para.runs.map(r => r.font));
    if (fonts.size === 1) {
      const font = para.runs[0].font;
      if (font !== bodyFont) {
        map.set(text, { font });
        continue;
      }
    }

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
 * Processes a single XHTML file:
 * 1. Injects font-family styles on elements with non-body fonts
 * 2. Strips pandoc's inline absolute font-size/line-height
 * 3. Converts section break markers into page-break-after styled elements
 */
function injectFontsIntoXhtml(
  content: string,
  fontMap: Map<string, FontMapEntry>
): InjectResult {
  let modified = false;

  let result = content.replace(BLOCK_REGEX, (match, openTag: string, inner: string, closeTag: string) => {
    const textContent = normalizeText(stripHtmlTags(inner));
    if (textContent.length === 0) return match;

    const entry = fontMap.get(textContent);
    if (!entry) return match;

    modified = true;
    const styledTag = injectStyleOnTag(openTag, `font-family: '${entry.font}'`);
    return styledTag + inner + closeTag;
  });

  const cleaned = stripAbsoluteInlineStyles(result);
  if (cleaned !== result) {
    result = cleaned;
    modified = true;
  }

  const paged = replaceSectionBreakMarkers(result);
  if (paged !== result) {
    result = paged;
    modified = true;
  }

  return { content: result, modified };
}

/**
 * Injects a CSS style property into an opening HTML tag.
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
 * Strips pandoc-injected absolute font-size and line-height from inline styles.
 */
function stripAbsoluteInlineStyles(content: string): string {
  let result = content.replace(/font-size:\s*[\d.]+(?:pt|px)\s*;?\s*/gi, '');
  result = result.replace(/line-height:\s*[\d.]+(?:pt|px)\s*;?\s*/gi, '');
  result = result.replace(/\s*style="\s*;?\s*"/gi, '');
  return result;
}

/**
 * Replaces section break marker paragraphs with page-break-after styled elements.
 * The marker text was inserted by docx-preprocessor and passed through pandoc as-is.
 * Pandoc wraps it in a <p>. We find and replace the entire <p> with a page break span.
 */
function replaceSectionBreakMarkers(content: string): string {
  if (!content.includes(SECTION_BREAK_MARKER)) return content;

  // Split on marker text — the marker sits inside a <p>...</p>
  const parts = content.split(SECTION_BREAK_MARKER);
  if (parts.length <= 1) return content;

  let result = parts[0];
  for (let i = 1; i < parts.length; i++) {
    // Previous part ends with: ...<p> or ...<p class="...">
    // Remove the trailing <p...> open tag
    const openMatch = result.match(/<p[^>]*>$/);
    if (openMatch) {
      result = result.slice(0, -openMatch[0].length);
    }

    // Current part starts with: </p>...
    // Remove the leading </p>
    let part = parts[i];
    if (part.startsWith('</p>')) {
      part = part.slice(4);
    }

    result += '<span style="page-break-after: always"></span>' + part;
  }

  return result;
}
