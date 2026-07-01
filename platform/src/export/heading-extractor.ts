/**
 * Extracts headings from a .docx file by parsing word/document.xml and word/styles.xml.
 * OnlyOffice uses numeric style IDs, so we resolve them via styles.xml.
 */

import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';

export interface DocxHeading {
  level: number;       // 1-6
  text: string;        // Heading text content
  index: number;       // Sequential index (for identification)
}

export async function extractHeadings(docxPath: string): Promise<DocxHeading[]> {
  const zip = new AdmZip(docxPath);
  const docEntry = zip.getEntry('word/document.xml');
  const stylesEntry = zip.getEntry('word/styles.xml');

  if (!docEntry) {
    throw new Error('word/document.xml not found in docx');
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['w:p', 'w:r', 'w:t', 'w:hyperlink', 'w:style'].includes(name),
  });

  // Build style ID → heading level map from styles.xml
  const headingStyleMap = new Map<string, number>();
  if (stylesEntry) {
    const stylesXml = stylesEntry.getData().toString('utf8');
    const stylesDoc = parser.parse(stylesXml);
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
    console.log('[heading-extractor] Heading style map:', Object.fromEntries(headingStyleMap));
  }

  // Parse document.xml
  const xml = docEntry.getData().toString('utf8');
  const doc = parser.parse(xml);
  const body = doc?.['w:document']?.['w:body'];
  if (!body) return [];

  const paragraphs: any[] = Array.isArray(body['w:p']) ? body['w:p'] : (body['w:p'] ? [body['w:p']] : []);
  const headings: DocxHeading[] = [];
  let index = 0;

  for (const para of paragraphs) {
    const pStyle = para?.['w:pPr']?.['w:pStyle']?.['@_w:val'];
    if (!pStyle) continue;

    const level = headingStyleMap.get(pStyle);
    if (!level || level < 1 || level > 6) continue;

    let text = extractTextFromParagraph(para);
    text = text.trim();

    if (text) {
      headings.push({ level, text, index });
      index++;
    }
  }

  return headings;
}

function extractTextFromParagraph(para: any): string {
  let text = '';

  const runs = Array.isArray(para['w:r']) ? para['w:r'] : (para['w:r'] ? [para['w:r']] : []);
  for (const run of runs) {
    text += extractTextFromRun(run);
  }

  const hyperlinks = Array.isArray(para['w:hyperlink']) ? para['w:hyperlink'] : (para['w:hyperlink'] ? [para['w:hyperlink']] : []);
  for (const hl of hyperlinks) {
    const hlRuns = Array.isArray(hl['w:r']) ? hl['w:r'] : (hl['w:r'] ? [hl['w:r']] : []);
    for (const run of hlRuns) {
      text += extractTextFromRun(run);
    }
  }

  return text;
}

function extractTextFromRun(run: any): string {
  let text = '';
  const textNodes = Array.isArray(run['w:t']) ? run['w:t'] : (run['w:t'] ? [run['w:t']] : []);
  for (const t of textNodes) {
    if (typeof t === 'string') {
      text += t;
    } else if (typeof t === 'object' && t['#text'] !== undefined) {
      text += t['#text'];
    } else if (typeof t === 'number') {
      text += String(t);
    }
  }
  return text;
}
