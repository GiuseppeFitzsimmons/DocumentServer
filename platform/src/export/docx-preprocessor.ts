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
 * The sectPr is a property of the LAST paragraph in that section — meaning the
 * NEXT paragraph starts a new section/page. So we:
 * 1. Remove the w:sectPr from the pPr
 * 2. Find the enclosing <w:p> and insert a dedicated page-break paragraph AFTER it
 *
 * This produces: <w:p>...original...</w:p><w:p><w:r><w:br w:type="page"/></w:r></w:p>
 * Pandoc reliably converts a standalone page-break paragraph into an epub page break.
 *
 * The final body-level w:sectPr (direct child of w:body) is untouched.
 */
function replaceSectionBreaks(xml: string): TransformResult {
  let count = 0;

  // Step 1: Remove sectPr from pPr blocks and mark with a placeholder
  const MARKER = '\x00PAGEBREAK\x00';
  const pprPattern = /(<w:pPr\b[^>]*>)([\s\S]*?)(<w:sectPr\b[^>]*(?:\/>|>[\s\S]*?<\/w:sectPr>))([\s\S]*?)(<\/w:pPr>)/g;

  let result = xml.replace(pprPattern, (_, open: string, before: string, _sectPr: string, after: string, close: string) => {
    count++;
    // Place marker after the closing </w:pPr> — we'll move it to after </w:p> next
    return `${open}${before}${after}${close}${MARKER}`;
  });

  if (count === 0) {
    return { xml, changed: false, count: 0 };
  }

  // Step 2: The marker is now right after </w:pPr> inside the <w:p>...</w:p>.
  // We need to move it to AFTER the closing </w:p> of that paragraph.
  // Match: MARKER followed by content until </w:p>
  const movePattern = new RegExp(
    MARKER.replace(/\x00/g, '\\x00') + '([\\s\\S]*?)(</w:p>)',
    'g'
  );
  result = result.replace(movePattern, (_, innerContent: string, closeP: string) => {
    return `${innerContent}${closeP}<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
  });

  // Safety: remove any remaining markers (shouldn't happen)
  result = result.replace(new RegExp(MARKER.replace(/\x00/g, '\\x00'), 'g'), '');

  return { xml: result, changed: count > 0, count };
}

/**
 * Removes soft returns (w:br elements that are line breaks, not page/column breaks).
 * Replaces with a space-containing text run to prevent words from merging.
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

  // Strategy: match all w:br elements, replace soft returns with a space
  const result = xml.replace(/<w:br\b([^>]*?)(?:\/>|><\/w:br>)/g, (match, attrs: string) => {
    // If it has w:type="page" or w:type="column", keep it
    if (/w:type\s*=\s*"(page|column)"/.test(attrs)) {
      return match;
    }
    // Replace soft return with a space character in a text node
    // This prevents adjacent words from merging (e.g., "be\nIn" → "be In")
    count++;
    return '<w:t xml:space="preserve"> </w:t>';
  });

  return { xml: result, changed: count > 0, count };
}
