/**
 * Epub Font Injector - post-processes a pandoc-generated epub to embed fonts.
 *
 * Opens the epub as a zip archive, copies resolved font files into OEBPS/fonts/,
 * appends @font-face CSS declarations to the existing stylesheet, and updates
 * the OPF manifest with font file entries.
 */

import AdmZip from 'adm-zip';
import { readFileSync } from 'fs';
import path from 'path';
import type { FontResolutionResult } from './font-types.js';

/**
 * Input for the epub font injection process.
 */
export interface EpubFontInjectorInput {
  epubPath: string;
  resolvedFonts: FontResolutionResult[];
}

/**
 * Injects resolved font files into a pandoc-generated epub archive.
 *
 * Operations performed:
 * 1. Copies each resolved font file into OEBPS/fonts/ within the archive
 * 2. Appends @font-face CSS declarations to the existing stylesheet
 * 3. Updates the OPF manifest with <item> entries for each font
 *
 * If no resolved fonts are present, the epub is left unmodified.
 * If the epub cannot be opened or modified, throws a descriptive error.
 *
 * @param input - The epub path and resolved font entries
 */
export async function injectFontsIntoEpub(input: EpubFontInjectorInput): Promise<void> {
  const { epubPath, resolvedFonts } = input;

  // Filter to only fonts with a resolved file path
  const fontsToEmbed = resolvedFonts.filter(
    (r): r is FontResolutionResult & { filePath: string } => r.filePath !== null
  );

  // No-op if nothing to embed
  if (fontsToEmbed.length === 0) {
    return;
  }

  // Open the epub as a zip archive
  let zip: AdmZip;
  try {
    zip = new AdmZip(epubPath);
  } catch (err) {
    throw new Error(
      `Failed to open epub archive at ${epubPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Add each font file into OEBPS/fonts/
  for (const font of fontsToEmbed) {
    const filename = path.basename(font.filePath);
    const fontData = readFontFile(font.filePath);
    zip.addFile(`OEBPS/fonts/${filename}`, fontData);
  }

  // Find and update the CSS stylesheet
  const cssEntry = findStylesheet(zip);
  if (cssEntry === null) {
    throw new Error(
      'Failed to inject fonts: no CSS stylesheet found in epub archive (expected .css file under OEBPS/)'
    );
  }

  const existingCss = zip.getEntry(cssEntry)!.getData().toString('utf-8');
  const fontFaceDeclarations = generateFontFaceCSS(fontsToEmbed);
  const updatedCss = existingCss + '\n' + fontFaceDeclarations;
  zip.updateFile(cssEntry, Buffer.from(updatedCss, 'utf-8'));

  // Find and update the OPF manifest
  const opfEntry = findOpfFile(zip);
  if (opfEntry === null) {
    throw new Error(
      'Failed to inject fonts: no OPF manifest found in epub archive (expected .opf file)'
    );
  }

  const existingOpf = zip.getEntry(opfEntry)!.getData().toString('utf-8');
  const updatedOpf = insertManifestEntries(existingOpf, fontsToEmbed, opfEntry);
  zip.updateFile(opfEntry, Buffer.from(updatedOpf, 'utf-8'));

  // Write the modified zip back to disk
  try {
    zip.writeZip(epubPath);
  } catch (err) {
    throw new Error(
      `Failed to write modified epub to ${epubPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Reads a font file from disk. Throws a descriptive error if the file cannot be read.
 */
function readFontFile(filePath: string): Buffer {
  try {
    return readFileSync(filePath);
  } catch (err) {
    throw new Error(
      `Failed to read font file at ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Finds the CSS stylesheet within the epub archive.
 * Looks for .css files under OEBPS/ (pandoc typically generates OEBPS/stylesheet.css).
 * Returns the entry path or null if not found.
 */
function findStylesheet(zip: AdmZip): string | null {
  const entries = zip.getEntries();
  for (const entry of entries) {
    const name = entry.entryName;
    if (name.startsWith('OEBPS/') && name.endsWith('.css') && !entry.isDirectory) {
      return name;
    }
  }
  return null;
}

/**
 * Finds the OPF manifest file within the epub archive.
 * Looks for entries ending in .opf (pandoc typically generates OEBPS/content.opf).
 * Returns the entry path or null if not found.
 */
function findOpfFile(zip: AdmZip): string | null {
  const entries = zip.getEntries();
  for (const entry of entries) {
    const name = entry.entryName;
    if (name.endsWith('.opf') && !entry.isDirectory) {
      return name;
    }
  }
  return null;
}

/**
 * Generates @font-face CSS declarations for all fonts to be embedded.
 */
function generateFontFaceCSS(
  fonts: Array<FontResolutionResult & { filePath: string }>
): string {
  return fonts
    .map((font) => {
      const filename = path.basename(font.filePath);
      return `@font-face {
  font-family: "${font.record.family}";
  font-weight: ${font.record.weight};
  font-style: ${font.record.style};
  src: url("fonts/${filename}");
}`;
    })
    .join('\n\n');
}

/**
 * Inserts <item> entries for each font into the OPF manifest XML.
 * Uses string manipulation to find the closing </manifest> tag and insert before it.
 */
function insertManifestEntries(
  opfContent: string,
  fonts: Array<FontResolutionResult & { filePath: string }>,
  opfEntryPath: string
): string {
  const manifestCloseTag = '</manifest>';
  const insertIndex = opfContent.indexOf(manifestCloseTag);

  if (insertIndex === -1) {
    throw new Error(
      'Failed to update OPF manifest: could not find </manifest> closing tag'
    );
  }

  // Determine the relative path from the OPF file to the fonts directory
  const opfDir = path.posix.dirname(opfEntryPath);
  const fontsRelativeDir = path.posix.relative(opfDir, 'OEBPS/fonts');

  const itemEntries = fonts
    .map((font) => {
      const filename = path.basename(font.filePath);
      const sanitizedId = sanitizeId(filename);
      const mediaType = getMediaType(filename);
      const href = fontsRelativeDir ? `${fontsRelativeDir}/${filename}` : `fonts/${filename}`;
      return `    <item id="font-${sanitizedId}" href="${href}" media-type="${mediaType}"/>`;
    })
    .join('\n');

  return (
    opfContent.slice(0, insertIndex) +
    itemEntries +
    '\n' +
    opfContent.slice(insertIndex)
  );
}

/**
 * Sanitizes a filename into a valid XML id attribute value.
 * Removes the extension, converts to lowercase, and replaces non-alphanumeric chars with hyphens.
 */
function sanitizeId(filename: string): string {
  const nameWithoutExt = filename.replace(/\.[^.]+$/, '');
  return nameWithoutExt
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Returns the appropriate media-type for a font file based on its extension.
 */
function getMediaType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.ttf':
      return 'application/x-font-ttf';
    case '.otf':
      return 'application/x-font-opentype';
    default:
      return 'application/octet-stream';
  }
}
