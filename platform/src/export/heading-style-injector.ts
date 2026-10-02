/**
 * Heading Style Injector — post-processes a pandoc-generated epub to apply
 * PER-HEADING instance styling (font-size, letter-spacing, borders, and font
 * overrides) to the correct <hN> elements.
 *
 * Why this exists:
 *   The base stylesheet styles headings uniformly per level (h1, h2, ...), but
 *   real documents vary these per heading instance — e.g. most chapter titles
 *   have a top rule, while the title page and foreword do not. A per-level CSS
 *   selector cannot express that. This step reads the ordered, instance-resolved
 *   heading assignments produced by the font-assignment-extractor and writes the
 *   per-heading values as inline styles on the matching <hN> element.
 *
 * Matching strategy (fail-safe):
 *   Headings are matched to extractor assignments by normalized TEXT first,
 *   with document order as a tiebreak. If a heading element cannot be confidently
 *   matched, it is left untouched (keeps the stylesheet default) rather than
 *   risk applying the wrong heading's styles. Pandoc-synthesized headings with
 *   no docx counterpart (title page, nav/TOC) are skipped.
 *
 * Failure is cosmetic and contained: any error degrades to the pre-existing
 * uniform styling. The caller wraps this in best-effort try/catch.
 */

import AdmZip from 'adm-zip';
import { writeFileSync } from 'fs';
import type { ParagraphAssignment } from './font-assignment-extractor.js';
import { buildFontFamilyValue } from '../fonts/catalog.js';

/**
 * Default gap (pt) between a heading border and its text when the document's
 * border specifies no explicit w:space. Mirrors the editor's visual breathing
 * room so the exported rule doesn't hug the text.
 */
const BORDER_PADDING_DEFAULT_PT = 4;

export interface HeadingStyleInjectorInput {
  epubPath: string;
  /** Ordered paragraph assignments from the extractor (we use the heading ones). */
  paragraphs: ParagraphAssignment[];
  /** Document body font — a heading font override is only emitted when it differs. */
  bodyFont?: string;
  /** Per-level font that the stylesheet already applies (so we don't re-emit it). */
  headingFonts?: Map<number, string>;
}

interface HeadingTarget {
  level: number;
  text: string;        // normalized plain text
  assignment: ParagraphAssignment;
  used: boolean;
}

/**
 * Applies per-heading inline styles to content XHTML files in the epub.
 */
export async function injectHeadingStyles(input: HeadingStyleInjectorInput): Promise<void> {
  const { epubPath, paragraphs, bodyFont, headingFonts } = input;

  const headings = paragraphs.filter(p => typeof p.headingLevel === 'number');
  if (headings.length === 0) return;

  // Build the ordered list of heading targets we can match against.
  const targets: HeadingTarget[] = headings.map(p => ({
    level: p.headingLevel as number,
    text: normalizeText(p.runs.map(r => r.text).join('')),
    assignment: p,
    used: false,
  }));

  let zip: AdmZip;
  try {
    zip = new AdmZip(epubPath);
  } catch (err) {
    throw new Error(`Heading style injector: failed to open epub: ${err}`);
  }

  const contentFiles = findContentXhtml(zip);
  if (contentFiles.length === 0) return;

  let modified = false;

  for (const entryName of contentFiles) {
    const entry = zip.getEntry(entryName);
    if (!entry) continue;

    const content = entry.getData().toString('utf-8');
    const result = processFile(content, entryName, targets, bodyFont, headingFonts);
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
 * Content XHTML files, excluding nav and title-page (pandoc-synthesized pages
 * whose headings have no docx counterpart).
 */
function findContentXhtml(zip: AdmZip): string[] {
  return zip.getEntries()
    .filter(e => {
      if (e.isDirectory) return false;
      if (!/\.(xhtml|html)$/i.test(e.entryName)) return false;
      const lower = e.entryName.toLowerCase();
      if (lower.includes('nav')) return false;
      if (lower.includes('title_page')) return false;
      if (lower.includes('cover')) return false;
      return true;
    })
    .map(e => e.entryName)
    .sort();
}

/**
 * Processes a single XHTML file, injecting inline styles onto matched headings.
 */
function processFile(
  content: string,
  entryName: string,
  targets: HeadingTarget[],
  bodyFont?: string,
  headingFonts?: Map<number, string>
): { content: string; modified: boolean } {
  let modified = false;

  const headingRegex = /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi;

  const result = content.replace(headingRegex, (match, levelStr: string, attrs: string, inner: string) => {
    const level = Number(levelStr);

    // Skip pandoc-synthesized headings that carry a class we know is non-content
    // (title page / TOC title). These never correspond to a docx heading.
    if (/\bclass="[^"]*\b(title|toc-title|unnumbered)\b/i.test(attrs)) {
      return match;
    }

    const text = normalizeText(stripTags(inner));
    if (text === '') return match;

    const target = matchTarget(targets, level, text);
    if (!target) {
      // Fail-safe: no confident match → leave as-is (keeps stylesheet default).
      return match;
    }
    target.used = true;

    const style = buildHeadingInlineStyle(target.assignment, level, bodyFont, headingFonts);
    if (!style) return match;

    modified = true;
    return `<h${level}${injectStyleAttr(attrs, style)}>${inner}</h${level}>`;
  });

  return { content: result, modified };
}

/**
 * Finds the first unused heading target that matches BOTH level and normalized
 * text, in document order. Text match first; order is implicit via first-unused.
 * Returns null when there is no confident match.
 */
function matchTarget(targets: HeadingTarget[], level: number, text: string): HeadingTarget | null {
  for (const t of targets) {
    if (t.used) continue;
    if (t.level !== level) continue;
    if (t.text === text) return t;
  }
  return null;
}

/**
 * Builds the inline style string for a heading from its instance assignment.
 * Only emits properties that are present and meaningful:
 *   - font-size (pt) when the instance resolved a size
 *   - letter-spacing (pt) when character spacing is set
 *   - border-{top,bottom,left,right} when the instance has them
 *   - font-family (with generics) ONLY when it differs from the per-level
 *     stylesheet font (and from the body font), so we don't duplicate defaults
 * Returns null when nothing applies.
 */
function buildHeadingInlineStyle(
  assignment: ParagraphAssignment,
  level: number,
  bodyFont?: string,
  headingFonts?: Map<number, string>
): string | null {
  const parts: string[] = [];
  const s = assignment.style;

  if (s?.fontSize && s.fontSize > 0) {
    parts.push(`font-size: ${s.fontSize}pt`);
  }

  if (s?.letterSpacing !== undefined && s.letterSpacing !== 0) {
    parts.push(`letter-spacing: ${s.letterSpacing}pt`);
  }

  for (const [side, def] of [
    ['top', s?.borderTop],
    ['bottom', s?.borderBottom],
    ['left', s?.borderLeft],
    ['right', s?.borderRight],
  ] as const) {
    if (def) {
      parts.push(`border-${side}: ${def.width}pt ${def.style} #${def.color}`);
      // Gap between the rule and the text. Word stores this as w:space (pt).
      // CSS borders sit flush against the content box, so without padding the
      // rule hugs the text (tighter than the editor). When the doc specifies
      // no space, apply a modest default so the rule visually breathes.
      const pad = def.space > 0 ? def.space : BORDER_PADDING_DEFAULT_PT;
      parts.push(`padding-${side}: ${pad}pt`);
    }
  }

  // Font override: only when the heading's resolved font differs from the font
  // the stylesheet already sets for this level (falling back to body font).
  const levelFont = headingFonts?.get(level);
  const defaultFont = levelFont ?? bodyFont;
  if (assignment.font && assignment.font !== defaultFont) {
    parts.push(`font-family: ${buildFontFamilyValue(assignment.font)}`);
  }

  return parts.length > 0 ? parts.join('; ') : null;
}

/**
 * Merges a style string into an element's existing attributes. If a style
 * attribute already exists, appends to it (new declarations win via CSS order).
 */
function injectStyleAttr(attrs: string, style: string): string {
  const styleAttrRegex = /\sstyle="([^"]*)"/i;
  const existing = attrs.match(styleAttrRegex);
  if (existing) {
    const existingStyle = existing[1].trim();
    const sep = existingStyle === '' || existingStyle.endsWith(';') ? '' : '; ';
    return attrs.replace(styleAttrRegex, ` style="${existingStyle}${sep}${style}"`);
  }
  return `${attrs} style="${style}"`;
}

/** Removes HTML tags, leaving text content. */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

/**
 * Normalizes text for matching: decode a few common entities, collapse
 * whitespace, trim, lowercase. Headings may contain nested inline markup and
 * line breaks, so this must be tolerant.
 */
function normalizeText(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/g, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
