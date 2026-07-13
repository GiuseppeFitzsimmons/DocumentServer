/**
 * PDF Export Service - converts docx to PDF via pandoc + xelatex.
 *
 * Mirrors the EPUB export pipeline but targets PDF output:
 * 1. Extract per-element font assignments from the docx
 * 2. Preprocess docx (preserve empty paragraphs, section breaks, soft returns)
 * 3. Resolve fonts to actual font files on disk
 * 4. Generate a LaTeX preamble with fontspec declarations
 * 5. Run pandoc with --pdf-engine=xelatex and the custom preamble
 *
 * The result is a standards-compliant PDF with correct fonts embedded.
 */

import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { pipeline } from 'stream/promises';

import { extractFontsFromDocx } from './font-extractor.js';
import { resolveFonts } from './font-resolver.js';
import { extractFontAssignments } from './font-assignment-extractor.js';
import { preprocessDocx } from './docx-preprocessor.js';
import type { FontResolutionResult } from './font-types.js';
import type { FontAssignmentResult } from './font-assignment-extractor.js';

const PANDOC_TIMEOUT_MS = 60_000; // PDF can take longer than EPUB

const FONT_DIR = process.env.NODE_ENV === 'production'
  ? '/data/fonts'
  : path.resolve(process.cwd(), 'fonts');
const CORE_FONT_DIR = process.env.NODE_ENV === 'production'
  ? '/data/core-fonts'
  : path.resolve(process.cwd(), 'core-fonts');
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
  pageSize?: string;      // e.g. 'a4', 'letter', '6inx9in'
  margin?: string;        // e.g. '1in', '2.5cm'
}

/**
 * Generates a LaTeX preamble with fontspec font declarations.
 * Sets the main body font and heading fonts based on what's used in the document.
 */
function generateLatexPreamble(
  resolvedFonts: FontResolutionResult[],
  assignmentResult: FontAssignmentResult | null,
  fontDirs: string[]
): string {
  const lines: string[] = [
    '\\usepackage{fontspec}',
    '\\usepackage{unicode-math}',
    '',
    `% Font search paths`,
    ...fontDirs.map(dir => `\\newfontfamily\\customfont[Path=${dir}/]{}`.replace(/[{}]$/, '')),
  ];

  // Deduplicate font directories for fontspec Path option
  const pathOption = fontDirs.map(d => `{${d}/}`).join('');

  // Set main font (body font from document)
  const bodyFont = assignmentResult?.bodyFont;
  if (bodyFont) {
    const bodyResolved = resolvedFonts.find(
      r => r.record.family === bodyFont && r.record.weight === 'normal' && r.record.style === 'normal' && r.filePath
    );
    if (bodyResolved?.filePath) {
      const fontDir = path.dirname(bodyResolved.filePath);
      const fontFile = path.basename(bodyResolved.filePath);
      lines.push('');
      lines.push(`% Body font: ${bodyFont}`);
      lines.push(`\\setmainfont{${fontFile}}[`);
      lines.push(`  Path=${fontDir}/,`);

      // Find bold/italic variants
      const boldVariant = resolvedFonts.find(
        r => r.record.family === bodyFont && r.record.weight === 'bold' && r.record.style === 'normal' && r.filePath
      );
      const italicVariant = resolvedFonts.find(
        r => r.record.family === bodyFont && r.record.weight === 'normal' && r.record.style === 'italic' && r.filePath
      );
      const boldItalicVariant = resolvedFonts.find(
        r => r.record.family === bodyFont && r.record.weight === 'bold' && r.record.style === 'italic' && r.filePath
      );

      if (boldVariant?.filePath) {
        lines.push(`  BoldFont=${path.basename(boldVariant.filePath)},`);
      }
      if (italicVariant?.filePath) {
        lines.push(`  ItalicFont=${path.basename(italicVariant.filePath)},`);
      }
      if (boldItalicVariant?.filePath) {
        lines.push(`  BoldItalicFont=${path.basename(boldItalicVariant.filePath)},`);
      }

      lines.push(`]`);
    } else {
      // Font not resolved — try by name (system font fallback)
      lines.push('');
      lines.push(`% Body font (by name): ${bodyFont}`);
      lines.push(`\\setmainfont{${bodyFont}}`);
    }
  }

  // Set heading fonts if different from body
  if (assignmentResult?.headingFonts) {
    const uniqueHeadingFonts = new Set(assignmentResult.headingFonts.values());
    for (const headingFont of uniqueHeadingFonts) {
      if (headingFont === bodyFont) continue;

      const headingResolved = resolvedFonts.find(
        r => r.record.family === headingFont && r.record.weight === 'normal' && r.record.style === 'normal' && r.filePath
      );

      // Create a named font family for headings
      const safeName = headingFont.replace(/[^a-zA-Z]/g, '');
      if (headingResolved?.filePath) {
        const fontDir = path.dirname(headingResolved.filePath);
        const fontFile = path.basename(headingResolved.filePath);
        lines.push('');
        lines.push(`% Heading font: ${headingFont}`);
        lines.push(`\\newfontfamily\\${safeName}Font{${fontFile}}[Path=${fontDir}/]`);
      }
    }

    // Apply heading fonts to LaTeX heading commands
    for (const [level, font] of assignmentResult.headingFonts) {
      if (font === bodyFont) continue;
      const safeName = font.replace(/[^a-zA-Z]/g, '');
      const latexCmd = level === 1 ? 'section' : level === 2 ? 'subsection' : level === 3 ? 'subsubsection' : null;
      if (latexCmd) {
        lines.push(`\\addtokomafont{${latexCmd}}{\\${safeName}Font}`);
      }
    }
  }

  // Fallback font for missing glyphs (symbols, emoji, dingbats)
  lines.push('');
  lines.push('% Fallback for missing glyphs');
  lines.push('\\usepackage{newunicodechar}');

  return lines.join('\n');
}

/**
 * Runs pandoc to convert docx to PDF via xelatex.
 */
function runPandocPdf(
  inputPath: string,
  outputPath: string,
  preamblePath: string | null,
  options?: PdfConvertOptions
): Promise<void> {
  const args = [inputPath, '--pdf-engine=xelatex'];

  if (options?.includeToc) {
    args.push('--toc', '--toc-depth=3');
  }

  if (preamblePath) {
    args.push('-H', preamblePath);
  }

  // Page geometry
  const margin = options?.margin || '1in';
  const pageSize = options?.pageSize || 'a4';
  args.push('-V', `geometry:margin=${margin}`);
  args.push('-V', `papersize=${pageSize}`);

  // Set PDF metadata
  if (options?.title) {
    args.push('--metadata', `title=${options.title}`);
  }

  args.push('-o', outputPath);

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
          console.warn('[pdf-export] Pandoc warnings:', stderr);
        }
        resolve();
      },
    );
  });
}

export async function convertDocxToPdf(
  inputStream: Readable,
  options?: PdfConvertOptions
): Promise<PdfConvertResult> {
  const id = randomUUID();
  const tempDir = path.join(tmpdir(), `pdf-export-${id}`);
  const inputPath = path.join(tempDir, 'input.docx');
  const outputPath = path.join(tempDir, 'output.pdf');
  const preamblePath = path.join(tempDir, 'preamble.tex');

  await mkdir(tempDir, { recursive: true });

  // Write the input stream to temp file
  const writeStream = createWriteStream(inputPath);
  await pipeline(inputStream, writeStream);

  // Extract per-element font assignments
  let assignmentResult: FontAssignmentResult | null = null;
  try {
    assignmentResult = await extractFontAssignments(inputPath);
  } catch (err) {
    console.warn('[pdf-export] Font assignment extraction failed:', err);
  }

  // Preprocess docx (preserve empty paragraphs, section breaks, soft returns)
  try {
    await preprocessDocx({
      docxPath: inputPath,
      convertSectionBreaks: options?.convertSectionBreaks,
      removeSoftReturns: options?.removeSoftReturns,
    });
  } catch (err) {
    console.warn('[pdf-export] Docx preprocessing failed:', err);
  }

  // Extract and resolve fonts
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

  // Generate LaTeX preamble with font declarations
  let preambleFile: string | null = null;
  try {
    const preambleContent = generateLatexPreamble(
      resolvedFonts,
      assignmentResult,
      [FONT_DIR, CORE_FONT_DIR]
    );
    await writeFile(preamblePath, preambleContent, 'utf-8');
    preambleFile = preamblePath;
    console.log('[pdf-export] Generated LaTeX preamble with font declarations');
  } catch (err) {
    console.warn('[pdf-export] Preamble generation failed, proceeding without custom fonts:', err);
  }

  // Run pandoc
  await runPandocPdf(inputPath, outputPath, preambleFile, options);

  return {
    outputPath,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
