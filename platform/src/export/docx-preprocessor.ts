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
 *   <w:p><w:pPr>...<w:sectPr>...</w:sectPr></w:pPr><w:r>...</w:r></w:p>
 *
 * We remove the w:sectPr from pPr and insert a page break run as the first
 * content after pPr: <w:r><w:br w:type="page"/></w:r>
 * 
 * Pandoc reliably converts w:br type="page" into epub page breaks.
 * The final body-level w:sectPr (direct child of w:body) is untouched.
 */
function replaceSectionBreaks(xml: string): TransformResult {
  let count = 0;

  // Match the full paragraph containing a sectPr in its pPr.
  // Capture: (before-pPr)(pPr-open ... sectPr ... pPr-close)(after-pPr content)
  // Strategy: find pPr blocks containing sectPr, remove the sectPr,
  // then inject a page break run right after </w:pPr>.
  
  // Step 1: Remove sectPr from pPr blocks and mark the spot
  const MARKER = '<!--PAGEBREAK_MARKER-->';
  const pprPattern = /(<w:pPr\b[^>]*>)([\s\S]*?)(<w:sectPr\b[^>]*(?:\/>|>[\s\S]*?<\/w:sectPr>))([\s\S]*?)(<\/w:pPr>)/g;

  let result = xml.replace(pprPattern, (_, open: string, before: string, _sectPr: string, after: string, close: string) => {
    count++;
    return `${open}${before}${after}${close}${MARKER}`;
  });

  // Step 2: Replace markers with actual page break runs
  result = result.replace(new RegExp(MARKER, 'g'), '<w:r><w:br w:type="page"/></w:r>');

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
