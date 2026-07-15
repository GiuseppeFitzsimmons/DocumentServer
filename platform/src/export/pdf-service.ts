/**
 * PDF Export Service - converts docx to PDF via LibreOffice headless.
 *
 * Uses LibreOffice's built-in PDF export which produces KDP-compliant PDFs
 * with proper font embedding and layout fidelity.
 *
 * Post-processes with Ghostscript to fix page dimensions (LibreOffice has
 * a twips→mm→points rounding issue that produces e.g. 5.51" instead of 5.5").
 */

import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { mkdir, rm, rename } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { pipeline } from 'stream/promises';
import AdmZip from 'adm-zip';

const LIBREOFFICE_TIMEOUT_MS = 60_000;
const GS_TIMEOUT_MS = 30_000;

export class LibreOfficePdfError extends Error {
  public readonly stderr: string;
  public readonly exitCode: number;

  constructor(exitCode: number, stderr: string) {
    super(`LibreOffice exited with code ${exitCode}: ${stderr}`);
    this.name = 'LibreOfficePdfError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface PdfConvertResult {
  outputPath: string;
  cleanup: () => Promise<void>;
}

/**
 * Extracts page width and height in points from the docx.
 * Reads <w:pgSz w:w="..." w:h="..."/> (twips) and converts to points.
 */
function extractPageSizePoints(docxPath: string): { widthPt: number; heightPt: number } | null {
  try {
    const zip = new AdmZip(docxPath);
    const docEntry = zip.getEntry('word/document.xml');
    if (!docEntry) return null;

    const xml = docEntry.getData().toString('utf-8');
    const match = xml.match(/<w:pgSz[^>]*>/);
    if (!match) return null;

    const wMatch = match[0].match(/w:w="(\d+)"/);
    const hMatch = match[0].match(/w:h="(\d+)"/);
    if (!wMatch || !hMatch) return null;

    // Twips to points: 1 point = 20 twips
    const widthPt = parseInt(wMatch[1]) / 20;
    const heightPt = parseInt(hMatch[1]) / 20;

    console.log(`[pdf-export] Extracted page size: ${widthPt}pt × ${heightPt}pt (${(widthPt/72).toFixed(3)}" × ${(heightPt/72).toFixed(3)}")`);
    return { widthPt, heightPt };
  } catch (err) {
    console.warn('[pdf-export] Failed to extract page size:', err);
    return null;
  }
}

/**
 * Post-processes PDF with Ghostscript to set exact page dimensions.
 */
function fixPdfPageSize(inputPath: string, outputPath: string, widthPt: number, heightPt: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(
      'gs',
      [
        '-dNOPAUSE', '-dBATCH', '-dQUIET',
        '-sDEVICE=pdfwrite',
        `-dDEVICEWIDTHPOINTS=${widthPt}`,
        `-dDEVICEHEIGHTPOINTS=${heightPt}`,
        '-dFIXEDMEDIA',
        `-sOutputFile=${outputPath}`,
        inputPath,
      ],
      { timeout: GS_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (error) {
          console.warn('[pdf-export] Ghostscript page fix failed:', stderr);
          reject(error);
          return;
        }
        resolve();
      },
    );
  });
}

export async function convertDocxToPdf(inputStream: Readable): Promise<PdfConvertResult> {
  const id = randomUUID();
  const tempDir = path.join(tmpdir(), `pdf-export-${id}`);
  const inputPath = path.join(tempDir, 'input.docx');
  const loOutputPath = path.join(tempDir, 'input.pdf');
  const finalOutputPath = path.join(tempDir, 'output.pdf');

  await mkdir(tempDir, { recursive: true });

  // Write input to disk
  const writeStream = createWriteStream(inputPath);
  await pipeline(inputStream, writeStream);

  // Extract page size before conversion
  const pageSize = extractPageSizePoints(inputPath);

  // Run LibreOffice headless conversion
  await new Promise<void>((resolve, reject) => {
    execFile(
      'libreoffice',
      [
        '--headless',
        '--norestore',
        '--convert-to', 'pdf',
        '--outdir', tempDir,
        inputPath,
      ],
      {
        timeout: LIBREOFFICE_TIMEOUT_MS,
        env: {
          ...process.env,
          HOME: tempDir,
        },
      },
      (error, _stdout, stderr) => {
        if (error) {
          if (error.killed || error.signal) {
            reject(new LibreOfficePdfError(-1, 'LibreOffice conversion timed out'));
          } else {
            const exitCode = typeof (error as any).code === 'number'
              ? (error as any).code as number
              : 1;
            reject(new LibreOfficePdfError(exitCode, stderr));
          }
          return;
        }
        resolve();
      },
    );
  });

  // Post-process with Ghostscript to fix page size
  if (pageSize) {
    try {
      await fixPdfPageSize(loOutputPath, finalOutputPath, pageSize.widthPt, pageSize.heightPt);
      console.log(`[pdf-export] Ghostscript fixed page size to ${pageSize.widthPt}pt × ${pageSize.heightPt}pt`);
    } catch {
      // If gs fails, fall back to LibreOffice output
      await rename(loOutputPath, finalOutputPath);
    }
  } else {
    await rename(loOutputPath, finalOutputPath);
  }

  return {
    outputPath: finalOutputPath,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
