/**
 * XHTML Font Injector - post-processes pandoc-generated XHTML within an epub
 * to inject per-element font-family inline styles based on font assignments
 * extracted from the source docx.
 *
 * Uses positional cursor matching to correlate docx paragraphs to XHTML block
 * elements sequentially across all content files. The cursor carries across
 * file boundaries, maintaining 1:1 alignment with the ordered assignment list.
 */

import AdmZip from 'adm-zip';
import { writeFileSync } from 'fs';
import type { FontAssignmentResult, ParagraphAssignment } from './font-assignment-extractor.js';

export interface XhtmlFontInjectorInput {
  epubPath: string;
  assignments: FontAssignmentResult;
}

export interface CursorState {
  index: number;
}

/**
 * Injects font-family inline styles into XHTML content files within the epub.
 * Uses positional cursor matching to correlate paragraphs to XHTML block elements.
 * A single cursor walks through the ordered ParagraphAssignment[] array in sync
 * with block elements encountered sequentially across all content files.
 */
export async function injectXhtmlFonts(input: XhtmlFontInjectorInput): Promise<void> {
  const { epubPath, assignments } = input;
  const { bodyFont, paragraphs } = assignments;

  if (paragraphs.length === 0) return;

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

  const cursor: CursorState = { index: 0 };
  let modified = false;

  for (const entryName of xhtmlEntries) {
    const entry = zip.getEntry(entryName);
    if (!entry) continue;

    const content = entry.getData().toString('utf-8');
    const result = processContentFile(content, paragraphs, cursor, bodyFont);

    if (result.modified) {
      zip.updateFile(entryName, Buffer.from(result.content, 'utf-8'));
      modified = true;
    }
  }

  if (modified) {
    writeFileSync(epubPath, zip.toBuffer());
  }
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

/**
 * Determines if a block element's inner HTML is empty or contains only
 * whitespace/non-breaking space characters. Empty blocks are skipped entirely
 * by the positional cursor (no cursor advancement, no styling) because the
 * font-assignment-extractor produces no entries for empty paragraphs.
 */
export function isEmptyBlock(innerHtml: string): boolean {
  // Strip HTML tags
  const textOnly = innerHtml.replace(/<[^>]+>/g, '');
  // Remove non-breaking space entities and unicode equivalent
  const stripped = textOnly
    .replace(/&nbsp;/gi, '')
    .replace(/&#160;/g, '')
    .replace(/\u00A0/g, '');
  // Check if only whitespace remains
  return stripped.trim().length === 0;
}

/**
 * Builds an inline CSS style string for a single paragraph assignment.
 * Returns null when no styles apply (font matches body font and no
 * paragraph style properties are set).
 */
export function buildInlineStyles(assignment: ParagraphAssignment, bodyFont: string): string | null {
  const parts: string[] = [];

  // Font-family (only if different from body)
  const fonts = new Set(assignment.runs.map(r => r.font));
  if (fonts.size === 1 && assignment.runs[0].font !== bodyFont) {
    parts.push(`font-family: '${assignment.runs[0].font}'`);
  } else if (assignment.font && assignment.font !== bodyFont) {
    parts.push(`font-family: '${assignment.font}'`);
  }

  // Paragraph style properties
  if (assignment.style) {
    const s = assignment.style;
    if (s.textAlign && s.textAlign !== 'justify') {
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
    if (s.textIndent !== undefined) {
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

  if (parts.length === 0) {
    return null;
  }

  return parts.join('; ');
}

/**
 * Processes a single XHTML content file using positional cursor matching.
 * Walks block elements in document order and applies the corresponding style
 * from the assignments array at the current cursor position.
 *
 * Empty/whitespace-only blocks are SKIPPED without advancing the cursor,
 * because the font-assignment-extractor does not produce entries for empty
 * paragraphs (it returns null for paragraphs with no text runs). The cursor
 * only advances for non-empty blocks that have a corresponding assignment.
 *
 * @param content - The XHTML file content as a string
 * @param assignments - Ordered array of paragraph assignments from the docx
 * @param cursor - Mutable cursor state tracking position in the assignments array
 * @param bodyFont - The document's body font (used to determine if font-family should be injected)
 * @returns Object with the (possibly modified) content and whether any changes were made
 */
export function processContentFile(
  content: string,
  assignments: ParagraphAssignment[],
  cursor: CursorState,
  bodyFont: string
): { content: string; modified: boolean } {
  let modified = false;

  // Create a new regex instance to avoid shared lastIndex state
  const blockRegex = /(<(?:p|h[1-6]|li|blockquote|div)\b[^>]*>)([\s\S]*?)(<\/(?:p|h[1-6]|li|blockquote|div)>)/gi;

  const result = content.replace(blockRegex, (match, openTag: string, inner: string, closeTag: string) => {
    // If cursor exceeds assignment length, leave unstyled
    if (cursor.index >= assignments.length) {
      return match;
    }

    // Empty blocks (whitespace/nbsp only) advance the cursor without styling.
    // The font-assignment-extractor DOES produce entries for nbsp-preserved
    // paragraphs (the preprocessor inserts nbsp into empty paragraphs), so
    // we must advance the cursor to maintain alignment.
    if (isEmptyBlock(inner)) {
      cursor.index++;
      return match;
    }

    // Skip the pandoc-generated title-page <h1 class="unnumbered"> — this is
    // synthesized from --metadata title and has no docx body counterpart.
    // The actual title paragraph from the docx appears later as a <p> element.
    if (/^<h1\b[^>]*\bclass="[^"]*\bunnumbered\b/i.test(openTag)) {
      return match;
    }

    // DEBUG: log assignment text vs XHTML text for alignment checking
    const assignText = assignments[cursor.index].runs.map(r => r.text).join('').slice(0, 40);
    const blockText = inner.replace(/<[^>]+>/g, '').trim().slice(0, 40);
    if (assignText.replace(/\s+/g, ' ').toLowerCase() !== blockText.replace(/\s+/g, ' ').toLowerCase()) {
      console.log(`[xhtml-inject] MISMATCH at cursor=${cursor.index}: assign="${assignText}" vs block="${blockText}"`);
    }

    // Build inline styles for the assignment at the current cursor position
    const style = buildInlineStyles(assignments[cursor.index], bodyFont);
    cursor.index++;

    // If no styles apply, return match unchanged
    if (style === null) {
      return match;
    }

    // Inject style and mark as modified
    modified = true;
    const styledTag = injectStyleOnTag(openTag, style);
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
