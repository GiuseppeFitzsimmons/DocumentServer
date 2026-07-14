/**
 * PDF Export Service - converts docx to PDF via pandoc + xelatex.
 *
 * Extracts page geometry and font information from the docx, then
 * invokes pandoc with appropriate LaTeX options to produce a
 * standards-compliant PDF with correct page size.
 */

import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { pipeline } from 'stream/promises';
import AdmZip from 'adm-zip';

import { extractFontsFromDocx } from './font-extractor.js';
import { resolveFonts } from './font-resolver.js';
import { extractFontAssignments } from './font-assignment-extractor.js';
import { preprocessDocx } from './docx-preprocessor.js';
import type { FontResolutionResult } from './font-types.js';
import type { FontAssignmentResult } from './font-assignment-extractor.js';

const PANDOC_TIMEOUT_MS = 120_000;

const FONT_DIR = process.env.NODE_ENV === 'production'
  ? '/data/fonts'
  : path.resolve(process.cwd(), '..', 'fonts');
const CORE_FONT_DIR = process.env.NODE_ENV === 'production'
  ? '/data/core-fonts'
  : path.resolve(process.cwd(), '..', 'core-fonts');
const FONT_MAPPINGS_PATH = path.resolve(process.cwd(), 'config/font-mappings.json');

export class PandocPdfError extends Error {
  public readonly stderr: string;
  public readonly exitCode: number;

  constructor(exitCode: number, stderr: string) {
    super(`Pandoc PDF exited with code ${exitCode}: ${stderr}`);
    this.name = 'PandocPdfError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface PdfConvertResult {
  outputPath: string;
  cleanup: () => Promise<void>;
}

export interface PdfConvertOptions {
  title?: string;
  includeToc?: boolean;
  convertSectionBreaks?: boolean;
  removeSoftReturns?: boolean;
}

interface PageGeometry {
  paperWidth: string;   // e.g. "5.5in"
  paperHeight: string;  // e.g. "8.5in"
  marginTop: string;
  marginBottom: string;
  marginLeft: string;
  marginRight: string;
}

/**
 * Extracts page size and margins from docx's word/document.xml.
 * Values in the XML are in twips (1/20 of a point, 1/1440 of an inch).
 */
function extractPageGeometry(docxPath: string): PageGeometry {
  const defaults: PageGeometry = {
    paperWidth: '8.5in',
    paperHeight: '11in',
    marginTop: '1in',
    marginBottom: '1in',
    marginLeft: '1in',
    marginRight: '1in',
  };

  try {
    const zip = new AdmZip(docxPath);
    const docEntry = zip.getEntry('word/document.xml');
    if (!docEntry) return defaults;

    const xml = docEntry.getData().toString('utf-8');

    // Extract page size: <w:pgSz w:w="7920" w:h="12240"/>
    const pgSzMatch = xml.match(/<w:pgSz[^>]*>/);
    if (pgSzMatch) {
      const wMatch = pgSzMatch[0].match(/w:w="(\d+)"/);
      const hMatch = pgSzMatch[0].match(/w:h="(\d+)"/);
      if (wMatch) defaults.paperWidth = `${(parseInt(wMatch[1]) / 1440).toFixed(3)}in`;
      if (hMatch) defaults.paperHeight = `${(parseInt(hMatch[1]) / 1440).toFixed(3)}in`;
    }

    // Extract margins: <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" .../>
    const pgMarMatch = xml.match(/<w:pgMar[^>]*>/);
    if (pgMarMatch) {
      const topMatch = pgMarMatch[0].match(/w:top="(\d+)"/);
      const bottomMatch = pgMarMatch[0].match(/w:bottom="(\d+)"/);
      const leftMatch = pgMarMatch[0].match(/w:left="(\d+)"/);
      const rightMatch = pgMarMatch[0].match(/w:right="(\d+)"/);
      if (topMatch) defaults.marginTop = `${(parseInt(topMatch[1]) / 1440).toFixed(3)}in`;
      if (bottomMatch) defaults.marginBottom = `${(parseInt(bottomMatch[1]) / 1440).toFixed(3)}in`;
      if (leftMatch) defaults.marginLeft = `${(parseInt(leftMatch[1]) / 1440).toFixed(3)}in`;
      if (rightMatch) defaults.marginRight = `${(parseInt(rightMatch[1]) / 1440).toFixed(3)}in`;
    }
  } catch (err) {
    console.warn('[pdf-export] Failed to extract page geometry, using defaults:', err);
  }

  console.log(`[pdf-export] Page geometry: ${defaults.paperWidth} x ${defaults.paperHeight}, margins: T=${defaults.marginTop} B=${defaults.marginBottom} L=${defaults.marginLeft} R=${defaults.marginRight}`);
  return defaults;
}

/**
 * Generates a LaTeX preamble with fontspec font declarations.
 * Only emits declarations for fonts we can resolve to actual files.
 */
function generateLatexPreamble(
  resolvedFonts: FontResolutionResult[],
  assignmentResult: FontAssignmentResult | null,
): string {
  const lines: string[] = [
    '\\usepackage{fontspec}',
  ];

  const bodyFont = assignmentResult?.bodyFont;
  if (bodyFont) {
    const bodyResolved = resolvedFonts.find(
      r => r.record.family === bodyFont && r.record.weight === 'normal' && r.record.style === 'normal' && r.filePath
    );
    if (bodyResolved?.filePath) {
      const fontDir = path.dirname(bodyResolved.filePath);
      const fontFile = path.basename(bodyResolved.filePath);

      const boldVariant = resolvedFonts.find(
        r => r.record.family === bodyFont && r.record.weight === 'bold' && r.record.style === 'normal' && r.filePath
      );
      const italicVariant = resolvedFonts.find(
        r => r.record.family === bodyFont && r.record.weight === 'normal' && r.record.style === 'italic' && r.filePath
      );
      const boldItalicVariant = resolvedFonts.find(
        r => r.record.family === bodyFont && r.record.weight === 'bold' && r.record.style === 'italic' && r.filePath
      );

      const opts: string[] = [`Path=${fontDir}/`];
      if (boldVariant?.filePath) opts.push(`BoldFont=${path.basename(boldVariant.filePath)}`);
      if (italicVariant?.filePath) opts.push(`ItalicFont=${path.basename(italicVariant.filePath)}`);
      if (boldItalicVariant?.filePath) opts.push(`BoldItalicFont=${path.basename(boldItalicVariant.filePath)}`);

      lines.push('');
      lines.push(`% Body font: ${bodyFont}`);
      lines.push(`\\setmainfont{${fontFile}}[${opts.join(', ')}]`);
    }
  }

  // Heading fonts
  if (assignmentResult?.headingFonts) {
    const uniqueHeadingFonts = new Set(assignmentResult.headingFonts.values());
    for (const headingFont of uniqueHeadingFonts) {
      if (headingFont === bodyFont) continue;

      const headingResolved = resolvedFonts.find(
        r => r.record.family === headingFont && r.record.weight === 'normal' && r.record.style === 'normal' && r.filePath
      );

      if (headingResolved?.filePath) {
        const safeName = headingFont.replace(/[^a-zA-Z]/g, '') + 'Font';
        const fontDir = path.dirname(headingResolved.filePath);
        const fontFile = path.basename(headingResolved.filePath);
        lines.push('');
        lines.push(`% Heading font: ${headingFont}`);
        lines.push(`\\newfontfamily\\${safeName}{${fontFile}}[Path=${fontDir}/]`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Runs pandoc to produce PDF via xelatex.
 */
function runPandocPdf(
  inputPath: string,
  outputPath: string,
  preamblePath: string | null,
  geometry: PageGeometry,
  options?: PdfConvertOptions,
): Promise<void> {
  const args = [inputPath, '--pdf-engine=xelatex'];

  if (options?.includeToc) {
    args.push('--toc', '--toc-depth=3');
  }

  if (preamblePath) {
    args.push('-H', preamblePath);
  }

  // Page geometry from docx
  args.push(
    '-V', `geometry:paperwidth=${geometry.paperWidth}`,
    '-V', `geometry:paperheight=${geometry.paperHeight}`,
    '-V', `geometry:top=${geometry.marginTop}`,
    '-V', `geometry:bottom=${geometry.marginBottom}`,
    '-V', `geometry:left=${geometry.marginLeft}`,
    '-V', `geometry:right=${geometry.marginRight}`,
  );

  if (options?.title) {
    args.push('--metadata', `title=${options.title}`);
  }

  args.push('-o', outputPath);

  console.log(`[pdf-export] Running pandoc: pandoc ${args.join(' ')}`);

  return new Promise<void>((resolve, reject) => {
    execFile(
      'pandoc',
      args,
      { timeout: PANDOC_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (error) {
          if (error.killed || error.signal) {
            reject(new PandocPdfError(-1, 'Pandoc PDF conversion timed out'));
          } else {
            const exitCode = typeof (error as any).code === 'number'
              ? (error as any).code as number
              : 1;
            reject(new PandocPdfError(exitCode, stderr));
          }
          return;
        }
        if (stderr) {
          console.warn('[pdf-export] Pandoc warnings:', stderr.slice(0, 500));
        }
        resolve();
      },
    );
  });
}

export async function convertDocxToPdf(
  inputStream: Readable,
  options?: PdfConvertOptions,
): Promise<PdfConvertResult> {
  const id = randomUUID();
  const tempDir = path.join(tmpdir(), `pdf-export-${id}`);
  const inputPath = path.join(tempDir, 'input.docx');
  const outputPath = path.join(tempDir, 'output.pdf');
  const preamblePath = path.join(tempDir, 'preamble.tex');

  await mkdir(tempDir, { recursive: true });

  // Write input to disk
  const writeStream = createWriteStream(inputPath);
  await pipeline(inputStream, writeStream);

  // Extract page geometry from docx
  const geometry = extractPageGeometry(inputPath);

  // Extract font assignments
  let assignmentResult: FontAssignmentResult | null = null;
  try {
    assignmentResult = await extractFontAssignments(inputPath);
  } catch (err) {
    console.warn('[pdf-export] Font assignment extraction failed:', err);
  }

  // Preprocess docx
  try {
    await preprocessDocx({
      docxPath: inputPath,
      convertSectionBreaks: options?.convertSectionBreaks,
      removeSoftReturns: options?.removeSoftReturns,
    });
  } catch (err) {
    console.warn('[pdf-export] Docx preprocessing failed:', err);
  }

  // Resolve fonts
  let resolvedFonts: FontResolutionResult[] = [];
  try {
    const usageRecords = await extractFontsFromDocx(inputPath);
    resolvedFonts = await resolveFonts(usageRecords, {
      fontDirs: [FONT_DIR, CORE_FONT_DIR],
      lookupTablePath: FONT_MAPPINGS_PATH,
    });
  } catch (err) {
    console.warn('[pdf-export] Font resolution failed:', err);
  }

  // Generate preamble
  let preambleFile: string | null = null;
  try {
    const preambleContent = generateLatexPreamble(resolvedFonts, assignmentResult);
    if (preambleContent.trim().length > '\\usepackage{fontspec}'.length) {
      await writeFile(preamblePath, preambleContent, 'utf-8');
      preambleFile = preamblePath;
      console.log('[pdf-export] Generated preamble with custom fonts');
    } else {
      console.log('[pdf-export] No custom fonts resolved, using defaults');
    }
  } catch (err) {
    console.warn('[pdf-export] Preamble generation failed:', err);
  }

  // Run pandoc
  await runPandocPdf(inputPath, outputPath, preambleFile, geometry, options);

  console.log('[pdf-export] PDF generated successfully');

  return {
    outputPath,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
