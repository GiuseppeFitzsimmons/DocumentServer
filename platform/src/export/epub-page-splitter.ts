/**
 * Epub Page Splitter - splits XHTML files at section break markers.
 * 
 * Each split produces a new XHTML file in the epub, which guarantees a page
 * break on every e-reader (each spine entry starts on a fresh page).
 *
 * Called post-pandoc, after the xhtml-font-injector has run.
 */

import AdmZip from 'adm-zip';
import { writeFileSync } from 'fs';
import { SECTION_BREAK_MARKER } from './docx-preprocessor.js';

/**
 * Splits XHTML files in the epub at section break marker locations.
 * Each marker becomes a file boundary, ensuring a page break on all readers.
 */
export async function splitEpubAtPageBreaks(epubPath: string): Promise<void> {
  const zip = new AdmZip(epubPath);

  // Find the OPF file to get spine and manifest info
  const opfEntry = zip.getEntries().find(e => e.entryName.endsWith('.opf'));
  if (!opfEntry) {
    console.warn('[epub-page-splitter] No OPF file found');
    return;
  }

  const opfPath = opfEntry.entryName;
  let opfContent = opfEntry.getData().toString('utf-8');

  // Find XHTML files that contain the marker
  const xhtmlEntries = zip.getEntries().filter(e =>
    !e.isDirectory &&
    /\.(xhtml|html)$/.test(e.entryName) &&
    !e.entryName.toLowerCase().includes('nav')
  );

  let totalSplits = 0;

  for (const entry of xhtmlEntries) {
    const content = entry.getData().toString('utf-8');
    if (!content.includes(SECTION_BREAK_MARKER)) continue;

    // Split this file at marker points
    const splits = splitXhtmlAtMarkers(content);
    if (splits.length <= 1) continue;

    const originalName = entry.entryName;
    const dir = originalName.substring(0, originalName.lastIndexOf('/') + 1);
    const baseName = originalName.substring(originalName.lastIndexOf('/') + 1).replace(/\.(xhtml|html)$/, '');
    const ext = originalName.match(/\.(xhtml|html)$/)?.[0] || '.xhtml';

    // Update the original file with the first part
    zip.updateFile(originalName, Buffer.from(splits[0], 'utf-8'));

    // Find the manifest item id for the original file
    const hrefInOpf = originalName.startsWith(opfPath.substring(0, opfPath.lastIndexOf('/') + 1))
      ? originalName.substring(opfPath.lastIndexOf('/') + 1)
      : originalName;
    const relHref = getRelativeHref(opfPath, originalName);
    const originalId = findItemId(opfContent, relHref);

    // Add new files for subsequent parts
    const newIds: string[] = [];
    for (let i = 1; i < splits.length; i++) {
      const newFileName = `${dir}${baseName}_pb${i}${ext}`;
      const newRelHref = getRelativeHref(opfPath, newFileName);
      const newId = `${originalId || baseName}-pb${i}`;

      zip.addFile(newFileName, Buffer.from(splits[i], 'utf-8'));
      newIds.push(newId);

      // Add to OPF manifest
      const manifestItem = `    <item id="${newId}" href="${newRelHref}" media-type="application/xhtml+xml"/>`;
      opfContent = opfContent.replace('</manifest>', `${manifestItem}\n  </manifest>`);

      totalSplits++;
    }

    // Add new items to spine, right after the original
    if (originalId) {
      const spineRef = `<itemref idref="${originalId}"`;
      const spineMatch = opfContent.indexOf(spineRef);
      if (spineMatch !== -1) {
        // Find end of this itemref element
        const endOfItemref = opfContent.indexOf('/>', spineMatch) + 2;
        const newSpineRefs = newIds.map(id => `\n    <itemref idref="${id}"/>`).join('');
        opfContent = opfContent.slice(0, endOfItemref) + newSpineRefs + opfContent.slice(endOfItemref);
      }
    }
  }

  if (totalSplits === 0) return;

  // Write updated OPF
  zip.updateFile(opfPath, Buffer.from(opfContent, 'utf-8'));

  // Write epub back
  writeFileSync(epubPath, zip.toBuffer());
  console.log(`[epub-page-splitter] Split into ${totalSplits} additional file(s)`);
}

/**
 * Splits XHTML content at marker points.
 * Each part gets a full valid XHTML document structure.
 */
function splitXhtmlAtMarkers(content: string): string[] {
  // Find the marker — it's inside a <p>...</p>
  if (!content.includes(SECTION_BREAK_MARKER)) return [content];

  // Extract head section to reuse in split files
  const headMatch = content.match(/<head[^>]*>[\s\S]*?<\/head>/i);
  const head = headMatch ? headMatch[0] : '<head><meta charset="utf-8"/></head>';

  // Extract opening tags (html, body, etc.) and their attributes
  const htmlOpenMatch = content.match(/<html[^>]*>/i);
  const htmlOpen = htmlOpenMatch ? htmlOpenMatch[0] : '<html xmlns="http://www.w3.org/1999/xhtml">';

  const bodyOpenMatch = content.match(/<body[^>]*>/i);
  const bodyOpen = bodyOpenMatch ? bodyOpenMatch[0] : '<body>';

  // Get body content
  const bodyStartIdx = content.indexOf('>', content.indexOf('<body')) + 1;
  const bodyEndIdx = content.lastIndexOf('</body>');
  if (bodyStartIdx <= 0 || bodyEndIdx <= 0) return [content];

  const bodyContent = content.substring(bodyStartIdx, bodyEndIdx);

  // Split body content at markers, removing the marker paragraph
  const parts = splitBodyAtMarkers(bodyContent);
  if (parts.length <= 1) return [content];

  // Build full XHTML documents for each part
  const xmlDecl = content.match(/^<\?xml[^?]*\?>\s*/)?.[0] || '<?xml version="1.0" encoding="UTF-8"?>\n';
  const doctype = content.match(/<!DOCTYPE[^>]*>\s*/i)?.[0] || '';

  return parts.map(bodyPart => {
    return `${xmlDecl}${doctype}${htmlOpen}\n${head}\n${bodyOpen}\n${bodyPart}\n</body>\n</html>`;
  });
}

/**
 * Splits body content at marker locations.
 * Removes the <p> element containing the marker.
 */
function splitBodyAtMarkers(body: string): string[] {
  const segments = body.split(SECTION_BREAK_MARKER);
  if (segments.length <= 1) return [body];

  const results: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    let segment = segments[i];

    if (i > 0) {
      // Remove leading </p> that closed the marker paragraph
      segment = segment.replace(/^\s*<\/p>/, '');
    }

    if (i < segments.length - 1) {
      // Remove trailing <p...> that opened the marker paragraph
      segment = segment.replace(/<p[^>]*>\s*$/, '');
    }

    results.push(segment.trim());
  }

  return results;
}

/**
 * Gets the href relative to the OPF file location.
 */
function getRelativeHref(opfPath: string, filePath: string): string {
  const opfDir = opfPath.substring(0, opfPath.lastIndexOf('/') + 1);
  if (filePath.startsWith(opfDir)) {
    return filePath.substring(opfDir.length);
  }
  return filePath;
}

/**
 * Finds the manifest item id for a given href in the OPF content.
 */
function findItemId(opfContent: string, href: string): string | null {
  // Escape href for regex
  const escaped = href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = opfContent.match(new RegExp(`<item[^>]*id="([^"]*)"[^>]*href="${escaped}"`));
  if (match) return match[1];
  // Try reverse order (href before id)
  const match2 = opfContent.match(new RegExp(`<item[^>]*href="${escaped}"[^>]*id="([^"]*)"`));
  if (match2) return match2[1];
  return null;
}
