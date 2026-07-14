/**
 * PDF Export Service - converts docx to PDF via LibreOffice headless.
 *
 * Uses LibreOffice's built-in PDF export which produces KDP-compliant PDFs
 * with proper font embedding and layout fidelity.
 */

import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { mkdir, rm, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { pipeline } from 'stream/promises';

const LIBREOFFICE_TIMEOUT_MS = 60_000;

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

export async function convertDocxToPdf(inputStream: Readable): Promise<PdfConvertResult> {
  const id = randomUUID();
  const tempDir = path.join(tmpdir(), `pdf-export-${id}`);
  const inputPath = path.join(tempDir, 'input.docx');

  await mkdir(tempDir, { recursive: true });

  // Write input to disk
  const writeStream = createWriteStream(inputPath);
  await pipeline(inputStream, writeStream);

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
          HOME: tempDir, // Avoid profile lock conflicts on concurrent exports
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

  // Find the output PDF (LibreOffice names it input.pdf)
  const outputPath = path.join(tempDir, 'input.pdf');

  return {
    outputPath,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
