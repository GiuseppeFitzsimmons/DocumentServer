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
import { convertAndDownloadPdf, PdfConvertError } from './pdf-service.js';
import { extractHeadings } from './heading-extractor.js';
import { waitForSave } from '../ds/save-events.js';

const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

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
    const { config } = await import('../config.js');
    const jwtLib = await import('jsonwebtoken');
    const documentKey = `${file.id}_${file.updatedAt.getTime()}`;
    const dsCommandUrl = config.DS_INTERNAL_URL
      ? `${config.DS_INTERNAL_URL}/coauthoring/CommandService.ashx`
      : 'http://documentserver:8000/coauthoring/CommandService.ashx';

    const fsPayload = { c: 'forcesave', key: documentKey, userdata: 'epub-export' };
    const fsToken = jwtLib.default.sign(fsPayload, config.DS_JWT_SECRET, { expiresIn: '1m' });
    try {
      const fsResponse = await fetch(dsCommandUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${fsToken}` },
        body: JSON.stringify({ ...fsPayload, token: fsToken }),
      });
      const fsResult = await fsResponse.json();
      // error 0 = forcesave accepted, wait for callback to persist to S3
      if (fsResult.error === 0) {
        await waitForSave(file.id);
      }
      // error 1/3 = no changes or doc not open, S3 already current
    } catch (err) {
      console.warn('[epub-export] Forcesave before export failed (non-fatal):', err);
    }

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

// GET /api/files/:id/export/pdf — export docx to PDF via DS ConvertService (print mode)
exportRouter.get('/:id/export/pdf', async (req, res) => {
  let cleanup: (() => Promise<void>) | undefined;

  try {
    const userId = req.session.userId!;
    const file = await metadata.getFile(req.params.id);

    if (!file) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    if (file.mimeType !== DOCX_MIME_TYPE) {
      res.status(400).json({ error: 'Only .docx files can be exported to PDF' });
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

    // Force-save to ensure S3 has the latest version before converting
    const { config } = await import('../config.js');
    const jwtLib = await import('jsonwebtoken');
    const documentKey = `${file.id}_${file.updatedAt.getTime()}`;
    const dsCommandUrl = config.DS_INTERNAL_URL
      ? `${config.DS_INTERNAL_URL}/coauthoring/CommandService.ashx`
      : 'http://documentserver:8000/coauthoring/CommandService.ashx';

    const fsPayload = { c: 'forcesave', key: documentKey, userdata: 'pdf-export' };
    const fsToken = jwtLib.default.sign(fsPayload, config.DS_JWT_SECRET, { expiresIn: '1m' });
    try {
      const fsResponse = await fetch(dsCommandUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${fsToken}` },
        body: JSON.stringify({ ...fsPayload, token: fsToken }),
      });
      const fsResult = await fsResponse.json();
      if (fsResult.error === 0) {
        await waitForSave(file.id);
      }
    } catch (err) {
      console.warn('[pdf-export] Forcesave before export failed (non-fatal):', err);
    }

    // Re-fetch file metadata (updated_at may have changed after forcesave)
    const freshFile = await metadata.getFile(req.params.id);
    const fileForExport = freshFile || file;

    // Build a serve URL that DS can use to download the file
    const serveToken = jwtLib.default.sign(
      { fileId: fileForExport.id },
      config.DS_JWT_SECRET,
      { expiresIn: '5m' }
    );
    const fileUrl = `http://portal:3000/api/files/serve/${serveToken}`;
    const freshKey = `${fileForExport.id}_${fileForExport.updatedAt.getTime()}`;

    const result = await convertAndDownloadPdf(fileUrl, freshKey);
    cleanup = result.cleanup;

    const pdfName = file.name.replace(/\.docx$/i, '.pdf');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(pdfName)}"`);
    const outputStream = createReadStream(result.outputPath);
    outputStream.pipe(res);

    outputStream.on('error', (err) => {
      console.error('PDF stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Storage error' });
      }
    });

    await new Promise<void>((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
    });
  } catch (err) {
    if (err instanceof PdfConvertError) {
      console.error('PDF export error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'PDF conversion failed', detail: err.message });
      }
    } else {
      console.error('PDF export error:', err);
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
