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
import type { FontAssignmentResult, ParagraphAssignment, ParagraphStyle } from './font-assignment-extractor.js';

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

  // Build style map from all paragraphs
  const styleMap = buildStyleMap(paragraphs, bodyFont);
  if (styleMap.size === 0) return;

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
    const result = injectStylesIntoXhtml(content, styleMap);

    if (result.modified) {
      zip.updateFile(entryName, Buffer.from(result.content, 'utf-8'));
      modified = true;
    }
  }

  if (modified) {
    writeFileSync(epubPath, zip.toBuffer());
  }
}

interface StyleMapEntry {
  styles: string;  // Full CSS inline style string to inject
}

/**
 * Builds a map of normalized paragraph text → inline CSS styles.
 * Includes font-family (when different from body) and paragraph styles
 * (text-align, font-size, line-height, etc.) extracted from the docx.
 */
function buildStyleMap(
  paragraphs: ParagraphAssignment[],
  bodyFont: string
): Map<string, StyleMapEntry> {
  const map = new Map<string, StyleMapEntry>();

  for (const para of paragraphs) {
    const text = normalizeText(para.runs.map(r => r.text).join(''));
    if (text.length === 0) continue;

    const parts: string[] = [];

    // Font-family (only if different from body)
    const fonts = new Set(para.runs.map(r => r.font));
    if (fonts.size === 1 && para.runs[0].font !== bodyFont) {
      parts.push(`font-family: '${para.runs[0].font}'`);
    } else if (para.font && para.font !== bodyFont) {
      parts.push(`font-family: '${para.font}'`);
    }

    // Paragraph style properties
    if (para.style) {
      const s = para.style;
      if (s.textAlign && s.textAlign !== 'justify') {
        // Only inject non-justify (our CSS default is justify for p)
        parts.push(`text-align: ${s.textAlign}`);
      }
      if (s.fontSize) {
        parts.push(`font-size: ${s.fontSize}pt`);
      }
      if (s.lineHeight) {
        if (s.lineHeight <= 5) {
          // Multiplier (e.g., 1.5 = 150%)
          parts.push(`line-height: ${Math.round(s.lineHeight * 100)}%`);
        } else {
          // Absolute value in pt
          parts.push(`line-height: ${s.lineHeight}pt`);
        }
      }
      if (s.textIndent !== undefined && s.textIndent !== 0) {
        parts.push(`text-indent: ${s.textIndent}pt`);
      }
      if (s.spaceBefore) {
        parts.push(`margin-top: ${s.spaceBefore}pt`);
      }
      if (s.spaceAfter) {
        parts.push(`margin-bottom: ${s.spaceAfter}pt`);
      }
      if (s.marginLeft) {
        parts.push(`margin-left: ${s.marginLeft}pt`);
      }
      if (s.marginRight) {
        parts.push(`margin-right: ${s.marginRight}pt`);
      }
      if (s.borderTop) {
        parts.push(`border-top: ${s.borderTop.width}pt ${s.borderTop.style} #${s.borderTop.color}`);
      }
      if (s.borderBottom) {
        parts.push(`border-bottom: ${s.borderBottom.width}pt ${s.borderBottom.style} #${s.borderBottom.color}`);
      }
      if (s.borderLeft) {
        parts.push(`border-left: ${s.borderLeft.width}pt ${s.borderLeft.style} #${s.borderLeft.color}`);
      }
      if (s.borderRight) {
        parts.push(`border-right: ${s.borderRight.width}pt ${s.borderRight.style} #${s.borderRight.color}`);
      }
    }

    if (parts.length > 0) {
      map.set(text, { styles: parts.join('; ') });
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
 * 1. Injects inline styles (font-family, text-align, font-size, etc.) from docx
 */
function injectStylesIntoXhtml(
  content: string,
  styleMap: Map<string, StyleMapEntry>
): InjectResult {
  let modified = false;

  let result = content.replace(BLOCK_REGEX, (match, openTag: string, inner: string, closeTag: string) => {
    const textContent = normalizeText(stripHtmlTags(inner));
    if (textContent.length === 0) return match;

    const entry = styleMap.get(textContent);
    if (!entry) return match;

    modified = true;
    const styledTag = injectStyleOnTag(openTag, entry.styles);
    return styledTag + inner + closeTag;
  });

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
