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
import type { FontResolutionResult } from './font-types.js';

const PANDOC_TIMEOUT_MS = 30_000;

const FONT_DIR = path.resolve(process.cwd(), 'fonts');
const CORE_FONT_DIR = path.resolve(process.cwd(), 'core-fonts');
const FONT_MAPPINGS_PATH = path.resolve(process.cwd(), 'platform/config/font-mappings.json');

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
}

/**
 * Runs pandoc to convert a docx file to epub format.
 * Extracted as a helper to keep the main function clean with async/await.
 */
function runPandoc(inputPath: string, outputPath: string, options?: ConvertOptions): Promise<void> {
  const args = [inputPath, '--toc', '--toc-depth=3', '-o', outputPath];
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

  // Inject fonts into epub (best-effort)
  try {
    if (resolvedFonts.some(r => r.filePath !== null)) {
      await injectFontsIntoEpub({ epubPath: outputPath, resolvedFonts });
    }
  } catch (err) {
    console.warn('Font injection failed, returning epub without fonts:', err);
  }

  return {
    outputPath,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
