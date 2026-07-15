import { Router } from 'express';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { randomUUID } from 'crypto';
import { requireAuth } from '../auth/middleware.js';
import * as metadata from '../storage/metadata.js';
import * as storage from '../storage/s3.js';
import { getShare } from '../sharing/service.js';
import { convertDocxToEpub, PandocError, PandocTimeoutError } from './service.js';
import { extractHeadings } from './heading-extractor.js';
import { waitForSave } from '../ds/save-events.js';
import { getActiveDocumentKey } from '../ds/active-documents.js';
import { config } from '../config.js';
import jwt from 'jsonwebtoken';

const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const DS_COMMAND_URL = config.DS_INTERNAL_URL
  ? `${config.DS_INTERNAL_URL}/coauthoring/CommandService.ashx`
  : 'http://documentserver:8000/coauthoring/CommandService.ashx';

/**
 * Ensures the document is saved to S3 before export.
 * Sends a forcesave, waits for the callback event. Retries once if DS
 * returns "no changes" (error 3) — which can happen if an auto-save is mid-flight.
 */
async function ensureSavedToS3(fileId: string, documentKey: string): Promise<void> {
  // The document key DS has might differ from what's in the DB (updated_at changes on save).
  // Check Redis for the actual key DS is using for this open session.
  const activeKey = await getActiveDocumentKey(fileId);
  const effectiveKey = activeKey || documentKey;
  console.log(`[export:save] Starting ensureSavedToS3 for file=${fileId}, dbKey=${documentKey}, activeKey=${activeKey || 'none'}, using=${effectiveKey}`);

  for (let attempt = 0; attempt < 2; attempt++) {
    console.log(`[export:save] Attempt ${attempt + 1}: sending forcesave command with key=${effectiveKey}`);
    const payload = { c: 'forcesave', key: effectiveKey, userdata: 'export' };
    const token = jwt.sign(payload, config.DS_JWT_SECRET, { expiresIn: '1m' });

    try {
      const response = await fetch(DS_COMMAND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ ...payload, token }),
      });
      const responseText = await response.text();
      console.log(`[export:save] DS response (${response.status}): ${responseText}`);

      let result: any;
      try {
        result = JSON.parse(responseText);
      } catch {
        console.warn(`[export:save] Could not parse DS response as JSON`);
        return;
      }

      if (result.error === 0) {
        // Forcesave accepted — wait for callback to complete S3 upload
        console.log(`[export:save] Forcesave accepted (error=0), waiting for save event...`);
        const saved = await waitForSave(fileId);
        console.log(`[export:save] waitForSave resolved: ${saved ? 'CONFIRMED' : 'TIMED OUT'}`);
        return;
      }

      if (result.error === 1 || result.error === 3) {
        if (attempt === 0 && result.error === 3) {
          // "No changes" — might be a race with auto-save. Wait briefly and retry.
          console.log(`[export:save] Got error=3 (no changes), waiting 1s before retry`);
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        console.log(`[export:save] Got error=${result.error} (${result.error === 1 ? 'doc not open' : 'no changes'}), S3 should be current`);
        return;
      }

      // Other errors — proceed with whatever's in S3
      console.warn(`[export:save] Forcesave returned unexpected error=${result.error}, proceeding`);
      return;
    } catch (err) {
      console.warn('[export:save] Forcesave request failed:', err);
      return;
    }
  }
  console.log(`[export:save] Exhausted retries, proceeding with current S3 content`);
}

export const exportRouter = Router();
export const internalExportRouter = Router();

exportRouter.use(requireAuth);

// GET /api/files/:id/export/headings — extract headings from docx for section selection
exportRouter.get('/:id/export/headings', async (req, res) => {
  try {
    const userId = req.session.userId!;
    const file = await metadata.getFile(req.params.id);

    if (!file) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    if (file.userId !== userId) {
      const share = await getShare(file.id, userId);
      if (!share || !share.permissions.download) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
    }

    if (file.mimeType !== DOCX_MIME_TYPE) {
      res.status(400).json({ error: 'Only .docx files supported' });
      return;
    }

    // Download to temp file for parsing
    const tempDir = path.join(tmpdir(), `headings-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    const tempPath = path.join(tempDir, 'input.docx');

    const inputStream = await storage.download(file.s3Key);
    const writeStream = createWriteStream(tempPath);
    await pipeline(inputStream, writeStream);

    const headings = await extractHeadings(tempPath);

    // Cleanup
    const { rm } = await import('fs/promises');
    await rm(tempDir, { recursive: true, force: true });

    res.json(headings);
  } catch (err) {
    console.error('Heading extraction error:', err);
    res.status(500).json({ error: 'Failed to extract headings' });
  }
});

// Internal endpoint - only accessible via nginx internal redirect (no session required)
// Protected by X-Internal-Export header that nginx sets
internalExportRouter.all('/:id/epub', async (req, res) => {
  const internalHeader = req.headers['x-internal-export'];
  if (internalHeader !== 'true') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  let cleanup: (() => Promise<void>) | undefined;

  try {
    const file = await metadata.getFile(req.params.id);

    if (!file) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    if (file.mimeType !== DOCX_MIME_TYPE) {
      res.status(400).json({ error: 'Only .docx files can be exported to EPUB' });
      return;
    }

    const inputStream = await storage.download(file.s3Key);
    const title = file.name.replace(/\.docx$/i, '');
    const result = await convertDocxToEpub(inputStream, { title });
    cleanup = result.cleanup;

    const epubName = file.name.replace(/\.docx$/i, '.epub');

    res.setHeader('Content-Type', 'application/epub+zip');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(epubName)}"`);

    const outputStream = createReadStream(result.outputPath);
    outputStream.pipe(res);

    outputStream.on('error', (err) => {
      console.error('EPUB internal export stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Storage error' });
      }
    });

    await new Promise<void>((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
    });
  } catch (err) {
    if (err instanceof PandocTimeoutError) {
      console.error('EPUB internal export timeout:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Conversion timed out' });
      }
    } else if (err instanceof PandocError) {
      console.error('EPUB internal export Pandoc error:', err.stderr);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Conversion failed' });
      }
    } else {
      console.error('EPUB internal export error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Storage error' });
      }
    }
  } finally {
    if (cleanup) {
      await cleanup();
    }
  }
});

exportRouter.get('/:id/export/epub', async (req, res) => {
  let cleanup: (() => Promise<void>) | undefined;

  try {
    const userId = req.session.userId!;
    const file = await metadata.getFile(req.params.id);

    if (!file) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    if (file.mimeType !== DOCX_MIME_TYPE) {
      res.status(400).json({ error: 'Only .docx files can be exported to EPUB' });
      return;
    }

    // Authorization: owner or shared with download permission
    if (file.userId !== userId) {
      const share = await getShare(file.id, userId);
      if (!share || !share.permissions.download) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
    }

    // Force-save to ensure S3 has the latest version before exporting
    const documentKey = `${file.id}_${file.updatedAt.getTime()}`;
    console.log(`[epub-export] Starting export for file=${file.id}, name="${file.name}", updatedAt=${file.updatedAt.toISOString()}`);
    await ensureSavedToS3(file.id, documentKey);
    console.log(`[epub-export] ensureSavedToS3 complete, downloading from S3`);

    const inputStream = await storage.download(file.s3Key);
    const title = file.name.replace(/\.docx$/i, '');
    const includeToc = req.query.toc !== '0';
    const includeTitlePage = req.query.titlepage !== '0';
    const embedFonts = req.query.fonts !== '0';
    const convertSectionBreaks = req.query.sections === '1';
    const removeSoftReturns = req.query.softreturns === '0';
    const excludeSections = req.query.exclude
      ? String(req.query.exclude).split(',').map(Number).filter(n => !isNaN(n))
      : [];
    const result = await convertDocxToEpub(inputStream, { title, includeToc, includeTitlePage, embedFonts, excludeSections, convertSectionBreaks, removeSoftReturns });
    cleanup = result.cleanup;

    const epubName = file.name.replace(/\.docx$/i, '.epub');

    res.setHeader('Content-Type', 'application/epub+zip');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(epubName)}"`);

    const outputStream = createReadStream(result.outputPath);
    outputStream.pipe(res);

    outputStream.on('error', (err) => {
      console.error('EPUB stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Storage error' });
      }
    });

    // Wait for the response to finish before cleanup
    await new Promise<void>((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
    });
  } catch (err) {
    if (err instanceof PandocTimeoutError) {
      console.error('EPUB export timeout:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Conversion timed out' });
      }
    } else if (err instanceof PandocError) {
      console.error('EPUB export Pandoc error:', err.stderr);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Conversion failed' });
      }
    } else {
      console.error('EPUB export error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Storage error' });
      }
    }
  } finally {
    if (cleanup) {
      await cleanup();
    }
  }
});


