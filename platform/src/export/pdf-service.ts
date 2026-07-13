/**
 * PDF Export Service - converts docx to PDF via ONLYOFFICE ConvertService.
 *
 * Uses the Document Server's ConvertService with `documentLayout.isPrint: true`
 * to produce the same high-quality, layout-faithful PDF that the print preview
 * generates. This is the same rendering engine that displays pages in the editor,
 * so the output matches exactly what the user sees.
 *
 * This avoids the pandoc/xelatex approach which can't faithfully reproduce
 * OOXML visual layout.
 */

import jwt from 'jsonwebtoken';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { config } from '../config.js';

const DS_CONVERT_URL = (() => {
  if (config.DS_INTERNAL_URL) return `${config.DS_INTERNAL_URL}/ConvertService.ashx`;
  return 'http://documentserver:8000/ConvertService.ashx';
})();

const CONVERT_TIMEOUT_MS = 60_000;

export class PdfConvertError extends Error {
  public readonly dsError: number;

  constructor(dsError: number, message?: string) {
    super(message || `DS ConvertService returned error ${dsError}`);
    this.name = 'PdfConvertError';
    this.dsError = dsError;
  }
}

export interface PdfConvertResult {
  outputPath: string;
  cleanup: () => Promise<void>;
}

/**
 * Converts a docx file to PDF using the Document Server's ConvertService
 * with print mode enabled (produces the same PDF as the print preview).
 *
 * @param fileUrl - URL where DS can download the source document (must be accessible from DS container)
 * @param documentKey - The document key (used for caching/dedup by DS)
 */
export async function convertDocxToPdf(
  fileUrl: string,
  documentKey: string,
): Promise<{ pdfUrl: string }> {
  const payload: Record<string, unknown> = {
    async: false,
    filetype: 'docx',
    outputtype: 'pdf',
    key: `pdf_${documentKey}_${Date.now()}`,
    url: fileUrl,
    documentLayout: {
      isPrint: true,
    },
  };

  const token = jwt.sign(payload, config.DS_JWT_SECRET, { expiresIn: '5m' });

  const response = await fetch(DS_CONVERT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ ...payload, token }),
    signal: AbortSignal.timeout(CONVERT_TIMEOUT_MS),
  });

  const text = await response.text();
  let result: any;
  try {
    result = JSON.parse(text);
  } catch {
    // DS may return XML — parse FileUrl from it
    const urlMatch = text.match(/<FileUrl>(.*?)<\/FileUrl>/);
    const errMatch = text.match(/<Error>(.*?)<\/Error>/);
    if (errMatch) {
      throw new PdfConvertError(parseInt(errMatch[1]) || -1, `ConvertService error: ${errMatch[1]}`);
    }
    if (urlMatch) {
      return { pdfUrl: urlMatch[1] };
    }
    throw new PdfConvertError(-1, `ConvertService returned unexpected response: ${text.slice(0, 300)}`);
  }

  if (result.error) {
    throw new PdfConvertError(result.error, `ConvertService error ${result.error}`);
  }

  if (!result.fileUrl) {
    throw new PdfConvertError(-1, `ConvertService returned no fileUrl: ${JSON.stringify(result)}`);
  }

  return { pdfUrl: result.fileUrl };
}

/**
 * Full pipeline: downloads the PDF from DS's convert result and returns a local file path.
 */
export async function convertAndDownloadPdf(
  fileUrl: string,
  documentKey: string,
): Promise<PdfConvertResult> {
  const { pdfUrl } = await convertDocxToPdf(fileUrl, documentKey);

  // Download the resulting PDF from DS
  const id = randomUUID();
  const tempDir = path.join(tmpdir(), `pdf-export-${id}`);
  const outputPath = path.join(tempDir, 'output.pdf');

  await mkdir(tempDir, { recursive: true });

  const pdfResponse = await fetch(pdfUrl, {
    signal: AbortSignal.timeout(CONVERT_TIMEOUT_MS),
  });

  if (!pdfResponse.ok || !pdfResponse.body) {
    throw new PdfConvertError(-1, `Failed to download PDF from ${pdfUrl}: ${pdfResponse.status}`);
  }

  const nodeStream = Readable.fromWeb(pdfResponse.body as any);
  const writeStream = createWriteStream(outputPath);
  await pipeline(nodeStream, writeStream);

  return {
    outputPath,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
