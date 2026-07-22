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

  const zip = new AdmZip(docxPath);
  const docEntry = zip.getEntry('word/document.xml');
  if (!docEntry) {
    console.warn('[docx-preprocessor] word/document.xml not found');
    return;
  }

  let xml = docEntry.getData().toString('utf-8');
  let modified = false;

  // Always preserve empty paragraphs (pandoc strips them otherwise)
  const preserved = preserveEmptyParagraphs(xml);
  if (preserved.changed) {
    xml = preserved.xml;
    modified = true;
    console.log(`[docx-preprocessor] Preserved ${preserved.count} empty paragraph(s)`);
  }

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

  // Always promote direct paragraph formatting to named styles.
  // This must run AFTER other transformations and writes back independently
  // because it modifies both document.xml AND styles.xml.
  try {
    const promoted = promoteDirectFormatting(docxPath);
    if (promoted > 0) {
      console.log(`[docx-preprocessor] Promoted ${promoted} direct-formatted paragraph(s) to named styles`);
    }
  } catch (err) {
    console.warn('[docx-preprocessor] Direct formatting promotion failed:', err);
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
 * Replaces with a space to prevent words from merging.
 * 
 * Only removes breaks inside paragraphs that contain actual text.
 * Paragraphs that contain ONLY a break (used for visual spacing / hard returns)
 * are left untouched.
 *
 * NOT removed:
 *   <w:br w:type="page"/>             — page break
 *   <w:br w:type="column"/>           — column break
 *   <w:br/> in paragraphs with no text content (spacing paragraphs)
 */
function removeSoftBreaks(xml: string): TransformResult {
  let count = 0;

  // Process each paragraph: only replace w:br in paragraphs that contain w:t (text)
  const result = xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paraMatch) => {
    // Skip paragraphs with no text content (these are spacing/hard returns)
    if (!/<w:t[\s>]/.test(paraMatch)) {
      return paraMatch;
    }

    // Replace soft breaks in this text-containing paragraph
    return paraMatch.replace(/<w:br\b([^>]*?)(?:\/>|><\/w:br>)/g, (brMatch, attrs: string) => {
      if (/w:type\s*=\s*"(page|column)"/.test(attrs)) {
        return brMatch;
      }
      count++;
      return '<w:t xml:space="preserve"> </w:t>';
    });
  });

  return { xml: result, changed: count > 0, count };
}

/**
 * Preserves empty paragraphs by inserting a non-breaking space.
 * Pandoc strips empty paragraphs during epub conversion. By adding an nbsp,
 * the paragraph becomes non-empty and pandoc preserves it as <p>&#160;</p>,
 * rendering as a blank line in the epub (matching the author's intent).
 *
 * An "empty paragraph" is a <w:p> that contains no <w:t> elements.
 * Paragraphs containing only <w:br/> (spacing breaks) are also treated as empty.
 */
function preserveEmptyParagraphs(xml: string): TransformResult {
  let count = 0;

  const result = xml.replace(/<w:p\b([^>]*)>([\s\S]*?)<\/w:p>/g, (match, attrs: string, inner: string) => {
    // Skip if paragraph has text content
    if (/<w:t[\s>]/.test(inner)) return match;

    // Skip if paragraph has no runs at all and no break (just pPr — likely a section/structural para)
    // We only want to preserve paragraphs that are intentional blank lines
    if (!/<w:r[\s>]/.test(inner) && !/<w:br/.test(inner)) {
      // Check if it has pPr (styled empty paragraph — likely intentional spacing)
      if (!/<w:pPr/.test(inner)) return match;
    }

    // Insert a non-breaking space run
    count++;
    const nbsp = '<w:r><w:t xml:space="preserve">\u00A0</w:t></w:r>';
    return `<w:p${attrs}>${inner}${nbsp}</w:p>`;
  });

  return { xml: result, changed: count > 0, count };
}


/**
 * Promotes direct paragraph formatting (w:jc alignment) to named styles.
 * 
 * Pandoc's +styles extension only exposes named styles via custom-style Divs.
 * Direct formatting (e.g., text-align center applied to a single paragraph
 * without using a named style) is lost during conversion. This function:
 * 
 * 1. Scans document.xml for paragraphs with direct w:jc that don't already have a pStyle
 * 2. Creates synthetic styles in styles.xml (euro-center, euro-right, euro-left)
 * 3. Assigns the synthetic style to those paragraphs
 * 
 * This ensures the Lua filter can detect and apply the alignment.
 */
function promoteDirectFormatting(docxPath: string): number {
  const zip = new AdmZip(docxPath);
  const docEntry = zip.getEntry('word/document.xml');
  const stylesEntry = zip.getEntry('word/styles.xml');
  if (!docEntry) return 0;

  let docXml = docEntry.getData().toString('utf-8');
  let stylesXml = stylesEntry?.getData().toString('utf-8') || '';

  // Find the Normal style ID (the default paragraph style).
  // Attributes can appear in any order, so match the opening tag broadly
  // then check it contains all required attributes.
  let normalStyleId = 'Normal';
  const styleTagPattern = /<w:style\b([^>]*)>/g;
  let stMatch: RegExpExecArray | null;
  while ((stMatch = styleTagPattern.exec(stylesXml)) !== null) {
    const attrs = stMatch[1];
    if (
      /w:type="paragraph"/.test(attrs) &&
      /w:default="1"/.test(attrs)
    ) {
      const idMatch = attrs.match(/w:styleId="([^"]+)"/);
      if (idMatch) {
        normalStyleId = idMatch[1];
        break;
      }
    }
  }

  // Track which synthetic styles we need to create
  const neededStyles = new Set<string>();
  let count = 0;

  // Find paragraphs with direct w:jc but NO existing pStyle
  docXml = docXml.replace(
    /(<w:pPr\b[^>]*>)([\s\S]*?)(<\/w:pPr>)/g,
    (match, open: string, inner: string, close: string) => {
      if (/<w:pStyle\b/.test(inner)) return match;

      const jcMatch = inner.match(/<w:jc\s+w:val="([^"]+)"/);
      if (!jcMatch) return match;

      const alignment = jcMatch[1];
      if (alignment === 'both' || alignment === 'distribute') return match;

      const styleName = `euro-${alignment === 'start' ? 'left' : alignment === 'end' ? 'right' : alignment}`;
      neededStyles.add(styleName);
      count++;

      return `${open}<w:pStyle w:val="${styleName}"/>${inner}${close}`;
    }
  );

  if (count === 0) return 0;

  // Add synthetic styles to styles.xml
  const styleDefsToAdd: string[] = [];
  const alignMap: Record<string, string> = {
    'euro-center': 'center',
    'euro-right': 'right',
    'euro-left': 'left',
  };

  for (const styleName of neededStyles) {
    const align = alignMap[styleName] || 'center';
    if (!stylesXml.includes(`w:name w:val="${styleName}"`)) {
      // Use a high numeric ID to avoid collisions with existing OnlyOffice styles
      const numericId = styleName === 'euro-center' ? '9901' : styleName === 'euro-right' ? '9902' : '9903';
      styleDefsToAdd.push(
        `<w:style w:type="paragraph" w:styleId="${numericId}">` +
        `<w:name w:val="${styleName}"/>` +
        `<w:basedOn w:val="${normalStyleId}"/>` +
        `<w:pPr><w:jc w:val="${align}"/></w:pPr>` +
        `</w:style>`
      );
      // Update document.xml to use numeric ID instead of name
      docXml = docXml.replace(new RegExp(`w:val="${styleName}"`, 'g'), `w:val="${numericId}"`);
    }
  }

  if (styleDefsToAdd.length > 0) {
    stylesXml = stylesXml.replace(
      '</w:styles>',
      styleDefsToAdd.join('') + '</w:styles>'
    );
    zip.updateFile('word/styles.xml', Buffer.from(stylesXml, 'utf-8'));
  }

  zip.updateFile('word/document.xml', Buffer.from(docXml, 'utf-8'));
  writeFileSync(docxPath, zip.toBuffer());

  return count;
}
