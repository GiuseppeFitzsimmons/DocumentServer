/**
 * Epub Font Injector - post-processes a pandoc-generated epub to embed fonts.
 *
 * Opens the epub as a zip archive, copies resolved font files into a fonts/
 * subdirectory alongside the content, appends @font-face CSS declarations to
 * the existing stylesheet, and updates the OPF manifest with font file entries.
 *
 * Dynamically detects the epub's content directory (EPUB/, OEBPS/, or other)
 * by locating the OPF manifest file.
 */

import AdmZip from 'adm-zip';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { deflateRawSync } from 'zlib';
import type { FontResolutionResult } from './font-types.js';

/**
 * Input for the epub font injection process.
 */
export interface EpubFontInjectorInput {
  epubPath: string;
  resolvedFonts: FontResolutionResult[];
  bodyFont?: string;
  headingFonts?: Map<number, string>;
}

/**
 * Injects resolved font files into a pandoc-generated epub archive.
 *
 * Operations performed:
 * 1. Detects the content directory by locating the OPF file
 * 2. Copies each resolved font file into {contentDir}/fonts/ within the archive
 * 3. Appends @font-face CSS declarations to the existing stylesheet
 * 4. Updates the OPF manifest with <item> entries for each font
 *
 * If no resolved fonts are present, the epub is left unmodified.
 * If the epub cannot be opened or modified, throws a descriptive error.
 *
 * @param input - The epub path and resolved font entries
 */
export async function injectFontsIntoEpub(input: EpubFontInjectorInput): Promise<void> {
  const { epubPath, resolvedFonts, bodyFont, headingFonts } = input;

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

  // Find the OPF manifest to determine the content directory
  const opfEntry = findOpfFile(zip);
  if (opfEntry === null) {
    throw new Error(
      'Failed to inject fonts: no OPF manifest found in epub archive (expected .opf file)'
    );
  }
  const contentDir = path.posix.dirname(opfEntry);
  const fontsDir = contentDir ? `${contentDir}/fonts` : 'fonts';

  // Add each font file into {contentDir}/fonts/
  for (const font of fontsToEmbed) {
    const filename = path.basename(font.filePath);
    const fontData = readFontFile(font.filePath);
    zip.addFile(`${fontsDir}/${filename}`, fontData);
  }

  // Find and update the CSS stylesheet
  const cssEntry = findStylesheet(zip, contentDir);
  if (cssEntry === null) {
    throw new Error(
      `Failed to inject fonts: no CSS stylesheet found in epub archive (looked under "${contentDir}/")`
    );
  }

  // Compute the relative path from the CSS file to the fonts directory
  const cssDir = path.posix.dirname(cssEntry);
  const fontsRelativeToCSS = path.posix.relative(cssDir, fontsDir);

  const existingCss = zip.getEntry(cssEntry)!.getData().toString('utf-8');
  const fontFaceDeclarations = generateFontFaceCSS(fontsToEmbed, fontsRelativeToCSS);
  const bodyFontRule = generateBodyFontRule(fontsToEmbed, bodyFont);
  const headingFontRules = generateHeadingFontRules(headingFonts);
  const updatedCss = existingCss + '\n' + fontFaceDeclarations + '\n' + bodyFontRule + '\n' + headingFontRules;
  zip.updateFile(cssEntry, Buffer.from(updatedCss, 'utf-8'));

  // Update OPF manifest
  const existingOpf = zip.getEntry(opfEntry)!.getData().toString('utf-8');
  const updatedOpf = insertManifestEntries(existingOpf, fontsToEmbed, opfEntry, fontsDir);
  zip.updateFile(opfEntry, Buffer.from(updatedOpf, 'utf-8'));

  // Write the modified zip back to disk, ensuring mimetype is first and uncompressed
  try {
    writeEpub(zip, epubPath);
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
 * Writes the modified epub zip back to disk, ensuring the mimetype entry
 * is first in the archive and stored uncompressed (EPUB spec requirement).
 *
 * adm-zip's toBuffer() does not guarantee entry order, so we read all entries
 * from the modified zip and reconstruct it using a fresh AdmZip where we
 * manipulate the internal entries array to force mimetype first.
 */
function writeEpub(zip: AdmZip, outputPath: string): void {
  const entries = zip.getEntries();
  const mimetypeEntry = entries.find(e => e.entryName === 'mimetype');

  if (!mimetypeEntry) {
    writeFileSync(outputPath, zip.toBuffer());
    return;
  }

  // Collect all entry data
  const entryData: Array<{ name: string; data: Buffer; comment: string }> = [];

  // Mimetype first
  entryData.push({
    name: 'mimetype',
    data: mimetypeEntry.getData(),
    comment: '',
  });

  // All other entries in their original order
  for (const entry of entries) {
    if (entry.entryName === 'mimetype' || entry.isDirectory) continue;
    entryData.push({
      name: entry.entryName,
      data: entry.getData(),
      comment: entry.comment,
    });
  }

  // Build the zip from scratch with guaranteed order
  const outputBuffer = buildZipBuffer(entryData);
  writeFileSync(outputPath, outputBuffer);
}

/**
 * Builds a complete zip file buffer with entries in the exact order specified.
 * The first entry ('mimetype') is stored uncompressed per EPUB spec.
 */
function buildZipBuffer(
  entries: Array<{ name: string; data: Buffer; comment: string }>
): Buffer {
  const localHeaders: Buffer[] = [];
  const centralEntries: Buffer[] = [];
  let offset = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isFirst = i === 0; // mimetype — must be STORED with no extra
    const nameBuffer = Buffer.from(entry.name, 'utf-8');
    const data = entry.data;
    const commentBuffer = entry.comment ? Buffer.from(entry.comment, 'utf-8') : Buffer.alloc(0);

    let compressedData: Buffer;
    let method: number;

    if (isFirst) {
      // STORED — no compression
      method = 0;
      compressedData = data;
    } else {
      // DEFLATED
      method = 8;
      compressedData = deflateRawData(data);
    }

    const crc = crc32(data);

    // Local file header (30 bytes + filename)
    const local = Buffer.alloc(30 + nameBuffer.length);
    local.writeUInt32LE(0x04034b50, 0);       // signature
    local.writeUInt16LE(20, 4);                // version needed to extract
    local.writeUInt16LE(0, 6);                 // general purpose bit flag
    local.writeUInt16LE(method, 8);            // compression method
    local.writeUInt16LE(0, 10);                // last mod file time
    local.writeUInt16LE(0, 12);                // last mod file date
    local.writeUInt32LE(crc, 14);              // crc-32
    local.writeUInt32LE(compressedData.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22);      // uncompressed size
    local.writeUInt16LE(nameBuffer.length, 26); // file name length
    local.writeUInt16LE(0, 28);                // extra field length
    nameBuffer.copy(local, 30);

    localHeaders.push(Buffer.concat([local, compressedData]));

    // Central directory entry (46 bytes + filename + comment)
    const central = Buffer.alloc(46 + nameBuffer.length + commentBuffer.length);
    central.writeUInt32LE(0x02014b50, 0);      // signature
    central.writeUInt16LE(20, 4);              // version made by
    central.writeUInt16LE(20, 6);              // version needed
    central.writeUInt16LE(0, 8);               // flags
    central.writeUInt16LE(method, 10);         // compression method
    central.writeUInt16LE(0, 12);              // mod time
    central.writeUInt16LE(0, 14);              // mod date
    central.writeUInt32LE(crc, 16);            // crc-32
    central.writeUInt32LE(compressedData.length, 20); // compressed size
    central.writeUInt32LE(data.length, 24);    // uncompressed size
    central.writeUInt16LE(nameBuffer.length, 28); // file name length
    central.writeUInt16LE(0, 30);              // extra field length
    central.writeUInt16LE(commentBuffer.length, 32); // comment length
    central.writeUInt16LE(0, 34);              // disk number start
    central.writeUInt16LE(0, 36);              // internal file attrs
    central.writeUInt32LE(0, 38);              // external file attrs
    central.writeUInt32LE(offset, 42);         // relative offset of local header
    nameBuffer.copy(central, 46);
    if (commentBuffer.length > 0) {
      commentBuffer.copy(central, 46 + nameBuffer.length);
    }

    centralEntries.push(central);
    offset += local.length + compressedData.length;
  }

  const localSection = Buffer.concat(localHeaders);
  const centralSection = Buffer.concat(centralEntries);
  const centralOffset = localSection.length;
  const centralSize = centralSection.length;

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);           // signature
  eocd.writeUInt16LE(0, 4);                    // disk number
  eocd.writeUInt16LE(0, 6);                    // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);       // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);      // total entries
  eocd.writeUInt32LE(centralSize, 12);         // size of central directory
  eocd.writeUInt32LE(centralOffset, 16);       // offset of central directory
  eocd.writeUInt16LE(0, 20);                   // comment length

  return Buffer.concat([localSection, centralSection, eocd]);
}

/**
 * Deflates data using raw deflate (no zlib header).
 */
function deflateRawData(data: Buffer): Buffer {
  return deflateRawSync(data);
}

/**
 * Simple CRC-32 implementation.
 */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Finds the CSS stylesheet within the epub archive.
 * Looks for .css files under the content directory (detected dynamically).
 * Returns the entry path or null if not found.
 */
function findStylesheet(zip: AdmZip, contentDir: string): string | null {
  const prefix = contentDir ? `${contentDir}/` : '';
  const entries = zip.getEntries();
  for (const entry of entries) {
    const name = entry.entryName;
    if (name.startsWith(prefix) && name.endsWith('.css') && !entry.isDirectory) {
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
 * Uses the relative path from the CSS file location to the fonts directory.
 */
function generateFontFaceCSS(
  fonts: Array<FontResolutionResult & { filePath: string }>,
  fontsRelativePath: string
): string {
  return fonts
    .map((font) => {
      const filename = path.basename(font.filePath);
      const urlPath = fontsRelativePath ? `${fontsRelativePath}/${filename}` : filename;
      return `@font-face {
  font-family: "${font.record.family}";
  font-weight: ${font.record.weight};
  font-style: ${font.record.style};
  src: url("${urlPath}");
}`;
    })
    .join('\n\n');
}

/**
 * Generates a body/p CSS rule that assigns the document's body font.
 */
function generateBodyFontRule(
  fonts: Array<FontResolutionResult & { filePath: string }>,
  bodyFont?: string
): string {
  if (bodyFont) {
    return `body {\n  font-family: "${bodyFont}", serif;\n}\n\np {\n  font-family: "${bodyFont}", serif;\n}\n`;
  }

  // Legacy fallback: list all embedded fonts
  const seen = new Set<string>();
  const families: string[] = [];
  for (const font of fonts) {
    if (!seen.has(font.record.family)) {
      seen.add(font.record.family);
      families.push(font.record.family);
    }
  }

  if (families.length === 0) return '';

  const fontStack = families.map(f => `"${f}"`).join(', ') + ', serif';
  return `body {\n  font-family: ${fontStack};\n}\n`;
}

/**
 * Generates CSS rules for heading elements based on per-level font assignments.
 * These override the body font for headings that use a different typeface.
 */
function generateHeadingFontRules(headingFonts?: Map<number, string>): string {
  if (!headingFonts || headingFonts.size === 0) return '';

  const rules: string[] = [];
  for (const [level, font] of headingFonts) {
    if (level >= 1 && level <= 6) {
      rules.push(`h${level} {\n  font-family: "${font}";\n}`);
    }
  }
  return rules.join('\n\n') + '\n';
}

/**
 * Inserts <item> entries for each font into the OPF manifest XML.
 * Uses string manipulation to find the closing </manifest> tag and insert before it.
 */
function insertManifestEntries(
  opfContent: string,
  fonts: Array<FontResolutionResult & { filePath: string }>,
  opfEntryPath: string,
  fontsDir: string
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
  const fontsRelativeDir = path.posix.relative(opfDir, fontsDir);

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
