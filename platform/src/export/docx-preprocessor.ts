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
 * Since pandoc doesn't reliably convert w:br type="page" into CSS page breaks
 * in epub output, we use a marker-based approach:
 * 1. Remove the w:sectPr from the pPr
 * 2. Insert a paragraph with unique marker text after the enclosing </w:p>
 * 3. The xhtml-font-injector post-processes the epub to replace the marker
 *    with a page-break-styled element
 *
 * The final body-level w:sectPr (direct child of w:body) is untouched.
 */
const SECTION_BREAK_MARKER = '\u200B\u00AB\u00ABPAGEBREAK\u00BB\u00BB\u200B';

export { SECTION_BREAK_MARKER };

function replaceSectionBreaks(xml: string): TransformResult {
  let count = 0;

  // Step 1: Remove sectPr from pPr blocks and place a temporary marker
  const MARKER = '\x00PAGEBREAK\x00';
  const pprPattern = /(<w:pPr\b[^>]*>)([\s\S]*?)(<w:sectPr\b[^>]*(?:\/>|>[\s\S]*?<\/w:sectPr>))([\s\S]*?)(<\/w:pPr>)/g;

  let result = xml.replace(pprPattern, (_, open: string, before: string, _sectPr: string, after: string, close: string) => {
    count++;
    return `${open}${before}${after}${close}${MARKER}`;
  });

  if (count === 0) {
    return { xml, changed: false, count: 0 };
  }

  // Step 2: Move marker to after the enclosing </w:p>, then replace with
  // a paragraph containing the marker text that pandoc will pass through
  const movePattern = new RegExp(
    MARKER.replace(/\x00/g, '\\x00') + '([\\s\\S]*?)(</w:p>)',
    'g'
  );
  result = result.replace(movePattern, (_, innerContent: string, closeP: string) => {
    // Insert a new paragraph with marker text that pandoc will output as-is
    const markerPara = `<w:p><w:r><w:t>${SECTION_BREAK_MARKER}</w:t></w:r></w:p>`;
    return `${innerContent}${closeP}${markerPara}`;
  });

  // Safety: remove any remaining markers
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
