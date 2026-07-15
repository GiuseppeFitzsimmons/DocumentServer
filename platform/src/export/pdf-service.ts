/**
 * PDF Cleaning Service - runs Ghostscript on a PDF to normalize its structure.
 *
 * Fixes issues with ONLYOFFICE's native PDF export that cause KDP rejection:
 * - Adds explicit MediaBox to each page object
 * - Normalizes font references
 * - Removes problematic XMP metadata streams
 */

import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import { createWriteStream, createReadStream } from 'fs';
import { mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { pipeline } from 'stream/promises';

const GS_TIMEOUT_MS = 60_000;

export class GhostscriptError extends Error {
  public readonly stderr: string;
  public readonly exitCode: number;

  constructor(exitCode: number, stderr: string) {
    super(`Ghostscript exited with code ${exitCode}: ${stderr}`);
    this.name = 'GhostscriptError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface CleanPdfResult {
  outputPath: string;
  cleanup: () => Promise<void>;
}

/**
 * Runs Ghostscript on a PDF to normalize structure for KDP compliance.
 */
export async function cleanPdf(inputStream: Readable): Promise<CleanPdfResult> {
  const id = randomUUID();
  const tempDir = path.join(tmpdir(), `pdf-clean-${id}`);
  const inputPath = path.join(tempDir, 'input.pdf');
  const outputPath = path.join(tempDir, 'output.pdf');

  await mkdir(tempDir, { recursive: true });

  // Write input to disk
  const writeStream = createWriteStream(inputPath);
  await pipeline(inputStream, writeStream);

  // Run Ghostscript
  await new Promise<void>((resolve, reject) => {
    execFile(
      'gs',
      [
        '-dNOPAUSE', '-dBATCH', '-dQUIET',
        '-sDEVICE=pdfwrite',
        `-sOutputFile=${outputPath}`,
        inputPath,
      ],
      { timeout: GS_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (error) {
          if (error.killed || error.signal) {
            reject(new GhostscriptError(-1, 'Ghostscript timed out'));
          } else {
            const exitCode = typeof (error as any).code === 'number'
              ? (error as any).code as number
              : 1;
            reject(new GhostscriptError(exitCode, stderr));
          }
          return;
        }
        resolve();
      },
    );
  });

  return {
    outputPath,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
