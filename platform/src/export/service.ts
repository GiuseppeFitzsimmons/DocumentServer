import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { pipeline } from 'stream/promises';

import { extractFontsFromDocx } from './font-extractor.js';
import { resolveFonts } from './font-resolver.js';
import { injectFontsIntoEpub } from './epub-font-injector.js';
import { extractFontAssignments } from './font-assignment-extractor.js';
import { injectXhtmlFonts } from './xhtml-font-injector.js';
import { removeSections } from './section-remover.js';
import { preprocessDocx } from './docx-preprocessor.js';
import { splitEpubAtPageBreaks } from './epub-page-splitter.js';
import type { FontResolutionResult } from './font-types.js';
import type { FontAssignmentResult } from './font-assignment-extractor.js';

const PANDOC_TIMEOUT_MS = 30_000;

const FONT_DIR = process.env.NODE_ENV === 'production'
  ? '/data/fonts'
  : path.resolve(process.cwd(), 'fonts');
const CORE_FONT_DIR = process.env.NODE_ENV === 'production'
  ? '/data/core-fonts'
  : path.resolve(process.cwd(), 'core-fonts');
const FONT_MAPPINGS_PATH = path.resolve(process.cwd(), 'config/font-mappings.json');

export class PandocError extends Error {
  public readonly stderr: string;
  public readonly exitCode: number;

  constructor(exitCode: number, stderr: string) {
    super(`Pandoc exited with code ${exitCode}: ${stderr}`);
    this.name = 'PandocError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class PandocTimeoutError extends Error {
  constructor() {
    super('Pandoc conversion timed out after 30 seconds');
    this.name = 'PandocTimeoutError';
  }
}

export interface ConvertResult {
  outputPath: string;
  cleanup: () => Promise<void>;
}

export interface ConvertOptions {
  title?: string;
  includeToc?: boolean;
  embedFonts?: boolean;
  excludeSections?: number[];        // Heading indexes to exclude
  convertSectionBreaks?: boolean;    // Replace section breaks with page breaks
  removeSoftReturns?: boolean;       // Strip soft returns (manual line breaks)
}

/**
 * Runs pandoc to convert a docx file to epub format.
 * Extracted as a helper to keep the main function clean with async/await.
 */
function runPandoc(inputPath: string, outputPath: string, options?: ConvertOptions): Promise<void> {
  const cssPath = path.resolve(process.cwd(), 'config/epub-styles.css');
  const args = [inputPath];
  if (options?.includeToc !== false) {
    args.push('--toc', '--toc-depth=3');
  }
  args.push('--css', cssPath, '-o', outputPath);
  if (options?.title) {
    args.push('--metadata', `title=${options.title}`);
  }
  return new Promise<void>((resolve, reject) => {
    execFile(
      'pandoc',
      args,
      { timeout: PANDOC_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (error) {
          if (error.killed || error.signal) {
            reject(new PandocTimeoutError());
          } else {
            const exitCode = typeof (error as any).code === 'number'
              ? (error as any).code as number
              : 1;
            reject(new PandocError(exitCode, stderr));
          }
          return;
        }
        resolve();
      },
    );
  });
}

export async function convertDocxToEpub(inputStream: Readable, options?: ConvertOptions): Promise<ConvertResult> {
  const id = randomUUID();
  const tempDir = path.join(tmpdir(), `epub-export-${id}`);
  const inputPath = path.join(tempDir, 'input.docx');
  const outputPath = path.join(tempDir, 'output.epub');

  await mkdir(tempDir, { recursive: true });

  // Write the input stream to the temp file
  const writeStream = createWriteStream(inputPath);
  await pipeline(inputStream, writeStream);

  // Extract per-element font/style assignments BEFORE any docx modifications
  // (section removal and preprocessing can alter text content)
  let assignmentResult: FontAssignmentResult | null = null;
  try {
    assignmentResult = await extractFontAssignments(inputPath);
  } catch (err) {
    console.warn('Font assignment extraction failed, proceeding without per-element styling:', err);
  }

  // Remove excluded sections from docx (pre-pandoc)
  if (options?.excludeSections && options.excludeSections.length > 0) {
    try {
      await removeSections({ docxPath: inputPath, excludeIndexes: options.excludeSections });
    } catch (err) {
      console.warn('Section removal failed, proceeding with full document:', err);
    }
  }

  // Pre-pandoc transformations (section breaks → page breaks, soft return removal)
  if (options?.convertSectionBreaks || options?.removeSoftReturns) {
    try {
      await preprocessDocx({
        docxPath: inputPath,
        convertSectionBreaks: options.convertSectionBreaks,
        removeSoftReturns: options.removeSoftReturns,
      });

      // Debug: verify the marker was actually inserted
      if (options.convertSectionBreaks) {
        const AdmZip = (await import('adm-zip')).default;
        const debugZip = new AdmZip(inputPath);
        const debugDoc = debugZip.getEntry('word/document.xml')?.getData().toString('utf-8') ?? '';
        const markerCount = (debugDoc.match(/\u00AB\u00ABPAGEBREAK\u00BB\u00BB/g) || []).length;
        console.log(`[docx-preprocessor] Post-process: ${markerCount} page break marker(s) inserted`);
      }
    } catch (err) {
      console.warn('Docx preprocessing failed, proceeding without transformations:', err);
    }
  }

  // Extract and resolve fonts (best-effort)
  let resolvedFonts: FontResolutionResult[] = [];
  try {
    const usageRecords = await extractFontsFromDocx(inputPath);
    resolvedFonts = await resolveFonts(usageRecords, {
      fontDirs: [FONT_DIR, CORE_FONT_DIR],
      lookupTablePath: FONT_MAPPINGS_PATH,
    });
  } catch (err) {
    console.warn('Font extraction/resolution failed, proceeding without fonts:', err);
  }

  // Invoke Pandoc
  await runPandoc(inputPath, outputPath, options);

  // Inject per-element font-family styles into XHTML (best-effort)
  if (assignmentResult) {
    try {
      await injectXhtmlFonts({ epubPath: outputPath, assignments: assignmentResult });
    } catch (err) {
      console.warn('XHTML font injection failed, proceeding without per-element styling:', err);
    }
  }

  // Inject fonts into epub (best-effort)
  if (options?.embedFonts !== false) {
    try {
      if (resolvedFonts.some(r => r.filePath !== null)) {
        await injectFontsIntoEpub({
          epubPath: outputPath,
          resolvedFonts,
          bodyFont: assignmentResult?.bodyFont,
          headingFonts: assignmentResult?.headingFonts,
        });
      }
    } catch (err) {
      console.warn('Font injection failed, returning epub without fonts:', err);
    }
  }

  // Split XHTML files at section break markers (guaranteed page breaks)
  if (options?.convertSectionBreaks) {
    try {
      await splitEpubAtPageBreaks(outputPath);
    } catch (err) {
      console.warn('Epub page splitting failed:', err);
    }
  }

  return {
    outputPath,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
