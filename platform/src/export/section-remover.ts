/**
 * Removes sections from a docx file based on heading indexes.
 * A "section" is defined as everything from a heading to the next heading of equal or higher level.
 * Modifies the docx in-place by rewriting word/document.xml.
 */

import AdmZip from 'adm-zip';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { writeFileSync } from 'fs';

export interface SectionRemovalOptions {
  docxPath: string;
  excludeIndexes: number[];  // Heading indexes to exclude (from heading-extractor)
}

export async function removeSections(options: SectionRemovalOptions): Promise<void> {
  const { docxPath, excludeIndexes } = options;
  if (excludeIndexes.length === 0) return;

  const excludeSet = new Set(excludeIndexes);

  const zip = new AdmZip(docxPath);
  const docEntry = zip.getEntry('word/document.xml');
  const stylesEntry = zip.getEntry('word/styles.xml');

  if (!docEntry) {
    throw new Error('word/document.xml not found in docx');
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    preserveOrder: true,
    commentPropName: '#comment',
    textNodeName: '#text',
  });

  // Parse styles to build heading level map
  const headingStyleMap = new Map<string, number>();
  if (stylesEntry) {
    const stylesXml = stylesEntry.getData().toString('utf8');
    // Use a simpler parser for styles (non-order-preserving is fine here)
    const simpleParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      isArray: (name) => ['w:style'].includes(name),
    });
    const stylesDoc = simpleParser.parse(stylesXml);
    const styles = stylesDoc?.['w:styles']?.['w:style'] || [];
    for (const style of styles) {
      const styleId = style['@_w:styleId'];
      const styleName = style['w:name']?.['@_w:val'];
      if (!styleId || !styleName) continue;
      const match = styleName.match(/^heading\s*(\d)$/i);
      if (match) {
        headingStyleMap.set(styleId, parseInt(match[1], 10));
      }
    }
  }

  // Parse document.xml with preserved order
  const xml = docEntry.getData().toString('utf8');
  const doc = parser.parse(xml);

  // Navigate to body paragraphs
  const wDocument = doc.find((n: any) => n['w:document']);
  if (!wDocument) return;

  const wBody = wDocument['w:document'].find((n: any) => n['w:body']);
  if (!wBody) return;

  const bodyChildren: any[] = wBody['w:body'];

  // First pass: identify heading indexes and their positions
  interface HeadingPos {
    index: number;
    level: number;
    bodyIndex: number;
  }

  const headingPositions: HeadingPos[] = [];
  let headingIndex = 0;

  for (let i = 0; i < bodyChildren.length; i++) {
    const node = bodyChildren[i];
    if (!node['w:p']) continue;

    const para = node['w:p'];
    const pPr = para.find((n: any) => n['w:pPr']);
    if (!pPr) continue;

    const pPrChildren = pPr['w:pPr'];
    const pStyleNode = pPrChildren?.find((n: any) => n['w:pStyle']);
    if (!pStyleNode) continue;

    const styleId = pStyleNode['w:pStyle']?.[0]?.['@_w:val'] ||
                    pStyleNode[':@']?.['@_w:val'] ||
                    pStyleNode['w:pStyle']?.['@_w:val'];

    // Try to get styleId from attributes
    let resolvedStyleId: string | undefined;
    if (typeof styleId === 'string') {
      resolvedStyleId = styleId;
    } else if (pStyleNode[':@']?.['@_w:val']) {
      resolvedStyleId = pStyleNode[':@']['@_w:val'];
    }

    if (!resolvedStyleId) continue;

    const level = headingStyleMap.get(resolvedStyleId);
    if (!level || level < 1 || level > 6) continue;

    // Check if paragraph has text
    const hasText = para.some((n: any) => {
      if (n['w:r']) {
        const runs = Array.isArray(n['w:r']) ? n['w:r'] : [n['w:r']];
        return runs.some((r: any) => {
          const texts = Array.isArray(r) ? r : [r];
          return texts.some((t: any) => t['w:t']);
        });
      }
      return false;
    });

    if (hasText) {
      headingPositions.push({ index: headingIndex, level, bodyIndex: i });
      headingIndex++;
    }
  }

  // Second pass: determine which body children to remove
  const toRemove = new Set<number>();

  for (const hp of headingPositions) {
    if (!excludeSet.has(hp.index)) continue;

    // Remove from this heading to the next heading of equal or higher (lower number) level
    toRemove.add(hp.bodyIndex);

    // Find the end: next heading with level <= this level
    const nextHeading = headingPositions.find(
      h => h.bodyIndex > hp.bodyIndex && h.level <= hp.level
    );

    const endIndex = nextHeading ? nextHeading.bodyIndex : bodyChildren.length;

    for (let i = hp.bodyIndex + 1; i < endIndex; i++) {
      toRemove.add(i);
    }
  }

  if (toRemove.size === 0) return;

  // Filter body children
  wBody['w:body'] = bodyChildren.filter((_, i) => !toRemove.has(i));

  // Rebuild XML
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    preserveOrder: true,
    commentPropName: '#comment',
    textNodeName: '#text',
    format: false,
    suppressEmptyNode: false,
  });

  const newXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + builder.build(doc);

  // Write back to zip
  zip.updateFile('word/document.xml', Buffer.from(newXml, 'utf8'));
  writeFileSync(docxPath, zip.toBuffer());

  console.log(`[section-remover] Removed ${toRemove.size} paragraphs for ${excludeIndexes.length} excluded sections`);
}
