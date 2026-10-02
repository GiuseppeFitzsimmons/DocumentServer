import { Router } from 'express';
import { Readable } from 'stream';
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
import { cleanPdf, GhostscriptError } from './pdf-service.js';
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
 * Outcome of ensureSavedToS3.
 * - 'saved'       : a forcesave completed and S3 holds the fresh content.
 * - 'nochanges'   : the doc is open with no unsaved changes; S3 is current.
 * - 'notopen'     : no editing session matched any known key; S3 holds the
 *                   last saved state (which may lag behind the editor).
 */
type SaveOutcome = 'saved' | 'nochanges' | 'notopen';

/**
 * Sends a single forcesave for one key and interprets the DS response.
 * DS CommandService error codes:
 *   0 = accepted (save in progress)
 *   1 = document key not found / not open
 *   3 = no changes to save (doc open, already current)
 *   4 = command key does not match any open document
 * Returns:
 *   'accepted'   → forcesave queued (caller should await the callback)
 *   'nochanges'  → doc open on this key, already current
 *   'mismatch'   → key not open/matched (caller should try another key)
 *   'unknown'    → unexpected response
 */
async function sendForcesave(key: string): Promise<'accepted' | 'nochanges' | 'mismatch' | 'unknown'> {
  const payload = { c: 'forcesave', key, userdata: 'export' };
  const token = jwt.sign(payload, config.DS_JWT_SECRET, { expiresIn: '1m' });

  const response = await fetch(DS_COMMAND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ ...payload, token }),
  });
  const responseText = await response.text();
  console.log(`[export:save] DS response for key=${key} (${response.status}): ${responseText}`);

  let result: { error?: number };
  try {
    result = JSON.parse(responseText);
  } catch {
    console.warn('[export:save] Could not parse DS response as JSON');
    return 'unknown';
  }

  switch (result.error) {
    case 0: return 'accepted';
    case 3: return 'nochanges';
    case 1:
    case 4: return 'mismatch';
    default:
      console.warn(`[export:save] Unexpected DS error=${result.error}`);
      return 'unknown';
  }
}

/**
 * Ensures the document is force-saved to S3 before export.
 *
 * The key DS uses for a live editing session is the one assigned at editor
 * open: `${id}_${updatedAt_at_open}`, tracked in Redis (markDocumentOpen). The
 * DB-derived key drifts because each save bumps updated_at, so we must prefer
 * the Redis session key and only fall back to the DB key (e.g. after a platform
 * restart where Redis was lost).
 *
 * Returns a SaveOutcome so the caller can decide how to proceed and surface a
 * clear log when the forcesave did not land (rather than silently exporting
 * stale content, which was the original bug: a stale key → DS error 4 →
 * export of the previous version).
 */
async function ensureSavedToS3(fileId: string, documentKey: string): Promise<SaveOutcome> {
  const activeKey = await getActiveDocumentKey(fileId);

  // Start listening for a save-complete BEFORE issuing any forcesave, so we
  // can't miss a save that lands while the forcesave round-trips. The client
  // triggers api.forceSave() just before navigating to export, so a callback
  // is usually already in flight by the time we get here. This is the
  // authoritative signal that S3 holds the latest content.
  const pendingSave = waitForSave(fileId);

  // Candidate keys in priority order: Redis session key first, DB key as a
  // fallback. Deduped so we don't send the same key twice.
  const candidateKeys = [activeKey, documentKey].filter(
    (k, i, arr): k is string => !!k && arr.indexOf(k) === i
  );
  console.log(
    `[export:save] ensureSavedToS3 file=${fileId}, dbKey=${documentKey}, ` +
    `activeKey=${activeKey || 'none'}, candidates=[${candidateKeys.join(', ')}]`
  );

  for (const key of candidateKeys) {
    let outcome: Awaited<ReturnType<typeof sendForcesave>>;
    try {
      outcome = await sendForcesave(key);
    } catch (err) {
      console.warn('[export:save] Forcesave request failed:', err);
      return 'notopen';
    }

    if (outcome === 'accepted') {
      console.log('[export:save] Forcesave accepted, waiting for save callback...');
      const saved = await pendingSave;
      console.log(`[export:save] waitForSave: ${saved ? 'CONFIRMED' : 'TIMED OUT'}`);
      // Even on timeout, the forcesave was accepted; the callback may land
      // shortly. Treat as saved — the handler re-fetches the record.
      return 'saved';
    }

    if (outcome === 'nochanges') {
      // Doc is open on this key with no server-side unsaved changes. A
      // client-triggered forcesave may still be in flight, so wait for it
      // (bounded) before concluding S3 is current.
      console.log('[export:save] DS reports no changes; waiting for any in-flight client save...');
      const saved = await pendingSave;
      console.log(`[export:save] in-flight save: ${saved ? 'CONFIRMED' : 'none within timeout'}`);
      return saved ? 'saved' : 'nochanges';
    }

    if (outcome === 'mismatch') {
      // This key isn't the live session key — try the next candidate.
      console.log(`[export:save] Key ${key} not matched by DS; trying next candidate.`);
      continue;
    }

    // 'unknown' — bail without claiming success.
    break;
  }

  // No server-side forcesave matched (the live DS session key has rotated past
  // the keys we know). The client triggers api.forceSave() before navigating,
  // so a save callback is normally in flight — wait for it so we read the fresh
  // content rather than racing ahead to a stale S3 read (which was the bug:
  // export beat the client-triggered save on slower/deployed environments).
  console.log(
    `[export:save] No server-side forcesave matched for file=${fileId}; ` +
    `waiting for client-triggered save to land...`
  );
  const saved = await pendingSave;
  console.log(
    saved
      ? `[export:save] Client-triggered save confirmed for file=${fileId}.`
      : `[export:save] No save landed within timeout for file=${fileId}; exporting current S3 state.`
  );
  return saved ? 'saved' : 'notopen';
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

    // Force-save to ensure S3 has the latest version before exporting.
    const documentKey = `${file.id}_${file.updatedAt.getTime()}`;
    console.log(`[epub-export] Starting export for file=${file.id}, name="${file.name}", updatedAt=${file.updatedAt.toISOString()}`);
    const saveOutcome = await ensureSavedToS3(file.id, documentKey);
    console.log(`[epub-export] ensureSavedToS3 outcome=${saveOutcome}`);

    // Re-fetch the record so we read the freshly-saved state. After a forcesave
    // the callback updates metadata (size, and the version row); re-reading
    // guarantees we export the latest persisted content, not a pre-save snapshot.
    const latest = (await metadata.getFile(req.params.id)) ?? file;

    const inputStream = await storage.download(latest.s3Key);
    const title = latest.name.replace(/\.docx$/i, '');
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

    const epubName = latest.name.replace(/\.docx$/i, '.epub');

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



// POST /api/files/clean-pdf — accepts a PDF URL, runs Ghostscript, returns cleaned PDF
exportRouter.post('/clean-pdf', async (req, res) => {
  let cleanup: (() => Promise<void>) | undefined;

  try {
    const { url } = req.body;
    console.log(`[pdf-clean] Received clean request, url=${url ? url.slice(0, 100) : 'none'}`);

    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'URL is required' });
      return;
    }

    // Download the PDF from the provided URL (DS-generated)
    console.log(`[pdf-clean] Fetching PDF from DS...`);
    const pdfResponse = await fetch(url);
    if (!pdfResponse.ok || !pdfResponse.body) {
      console.error(`[pdf-clean] Failed to fetch PDF: ${pdfResponse.status}`);
      res.status(502).json({ error: `Failed to fetch PDF: ${pdfResponse.status}` });
      return;
    }
    console.log(`[pdf-clean] PDF fetched (${pdfResponse.status}), running Ghostscript...`);

    const nodeStream = Readable.fromWeb(pdfResponse.body as any);
    const result = await cleanPdf(nodeStream);
    cleanup = result.cleanup;
    console.log(`[pdf-clean] Ghostscript complete, sending cleaned PDF`);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="document.pdf"');

    const outputStream = createReadStream(result.outputPath);
    outputStream.pipe(res);

    outputStream.on('error', (err) => {
      console.error('PDF clean stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Storage error' });
      }
    });

    await new Promise<void>((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
    });
  } catch (err) {
    if (err instanceof GhostscriptError) {
      console.error('PDF clean error:', err.stderr);
      if (!res.headersSent) {
        res.status(500).json({ error: 'PDF cleaning failed', detail: err.message });
      }
    } else {
      console.error('PDF clean error:', err);
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
