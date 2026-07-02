/**
 * Docx Preprocessor - performs pre-pandoc transformations on a docx file.
 * Currently supports:
 * 1. Converting section breaks to page breaks
 * 2. Removing soft returns (manual line breaks)
 *
 * Operates in-place on the docx file by rewriting word/document.xml.
 */

import AdmZip from 'adm-zip';
import { writeFileSync } from 'fs';

export interface PreprocessOptions {
  docxPath: string;
  convertSectionBreaks?: boolean;  // Replace w:sectPr with page breaks
  removeSoftReturns?: boolean;     // Remove w:br (textWrapping) elements
}

export async function preprocessDocx(options: PreprocessOptions): Promise<void> {
  const { docxPath, convertSectionBreaks, removeSoftReturns } = options;

  if (!convertSectionBreaks && !removeSoftReturns) return;

  const zip = new AdmZip(docxPath);
  const docEntry = zip.getEntry('word/document.xml');
  if (!docEntry) {
    console.warn('[docx-preprocessor] word/document.xml not found');
    return;
  }

  let xml = docEntry.getData().toString('utf-8');
  let modified = false;

  if (convertSectionBreaks) {
    const result = replaceSectionBreaks(xml);
    if (result.changed) {
      xml = result.xml;
      modified = true;
      console.log(`[docx-preprocessor] Converted ${result.count} section break(s) to page breaks`);
    }
  }

  if (removeSoftReturns) {
    const result = removeSoftBreaks(xml);
    if (result.changed) {
      xml = result.xml;
      modified = true;
      console.log(`[docx-preprocessor] Removed ${result.count} soft return(s)`);
    }
  }

  if (modified) {
    zip.updateFile('word/document.xml', Buffer.from(xml, 'utf-8'));
    writeFileSync(docxPath, zip.toBuffer());
  }
}

interface TransformResult {
  xml: string;
  changed: boolean;
  count: number;
}

/**
 * Replaces paragraph-level section breaks (w:sectPr inside w:pPr) with page breaks.
 *
 * A paragraph-level section break looks like:
 *   <w:pPr>...<w:sectPr w:rsidR="...">...</w:sectPr>...</w:pPr>
 *
 * We remove the w:sectPr and insert <w:pageBreakBefore/> into the pPr instead,
 * which tells the rendering engine to start this paragraph on a new page.
 *
 * The final body-level w:sectPr (direct child of w:body) is untouched.
 */
function replaceSectionBreaks(xml: string): TransformResult {
  let count = 0;

  // Match w:sectPr that lives inside a w:pPr block.
  // The sectPr can be self-closing or have content.
  const pattern = /(<w:pPr\b[^>]*>)([\s\S]*?)(<w:sectPr\b[^>]*(?:\/>|>[\s\S]*?<\/w:sectPr>))([\s\S]*?)(<\/w:pPr>)/g;

  const result = xml.replace(pattern, (_, open: string, before: string, _sectPr: string, after: string, close: string) => {
    count++;
    // Check if pageBreakBefore already exists
    const combined = before + after;
    if (combined.includes('<w:pageBreakBefore')) {
      // Already has a page break, just remove the sectPr
      return `${open}${before}${after}${close}`;
    }
    // Insert pageBreakBefore
    return `${open}${before}<w:pageBreakBefore/>${after}${close}`;
  });

  return { xml: result, changed: count > 0, count };
}

/**
 * Removes soft returns (w:br elements that are line breaks, not page/column breaks).
 *
 * Soft returns in docx:
 *   <w:br/>                           — implicit text wrapping break
 *   <w:br w:type="textWrapping"/>     — explicit text wrapping break
 *
 * NOT removed:
 *   <w:br w:type="page"/>             — page break
 *   <w:br w:type="column"/>           — column break
 */
function removeSoftBreaks(xml: string): TransformResult {
  let count = 0;

  // Strategy: match all w:br elements, only remove those that are soft returns
  const result = xml.replace(/<w:br\b([^>]*?)(?:\/>|><\/w:br>)/g, (match, attrs: string) => {
    // If it has w:type="page" or w:type="column", keep it
    if (/w:type\s*=\s*"(page|column)"/.test(attrs)) {
      return match;
    }
    // Otherwise it's a soft return (no type, or type="textWrapping") — remove it
    count++;
    return '';
  });

  return { xml: result, changed: count > 0, count };
}
