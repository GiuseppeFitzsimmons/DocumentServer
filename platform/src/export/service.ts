import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { pipeline } from 'stream/promises';

const PANDOC_TIMEOUT_MS = 30_000;

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

export async function convertDocxToEpub(inputStream: Readable): Promise<ConvertResult> {
  const id = randomUUID();
  const tempDir = path.join(tmpdir(), `epub-export-${id}`);
  const inputPath = path.join(tempDir, 'input.docx');
  const outputPath = path.join(tempDir, 'output.epub');

  await mkdir(tempDir, { recursive: true });

  // Write the input stream to the temp file
  const writeStream = createWriteStream(inputPath);
  await pipeline(inputStream, writeStream);

  // Invoke Pandoc
  return new Promise<ConvertResult>((resolve, reject) => {
    execFile(
      'pandoc',
      [inputPath, '--toc', '--toc-depth=3', '-o', outputPath],
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

        resolve({
          outputPath,
          cleanup: async () => {
            await rm(tempDir, { recursive: true, force: true });
          },
        });
      },
    );
  });
}
