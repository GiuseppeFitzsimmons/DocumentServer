import { Router } from 'express';
import { createReadStream } from 'fs';
import { requireAuth } from '../auth/middleware.js';
import * as metadata from '../storage/metadata.js';
import * as storage from '../storage/s3.js';
import { getShare } from '../sharing/service.js';
import { convertDocxToEpub, PandocError, PandocTimeoutError } from './service.js';

const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const exportRouter = Router();
export const internalExportRouter = Router();

exportRouter.use(requireAuth);

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

    const inputStream = await storage.download(file.s3Key);
    const title = file.name.replace(/\.docx$/i, '');
    const includeToc = req.query.toc !== '0';
    const embedFonts = req.query.fonts !== '0';
    const result = await convertDocxToEpub(inputStream, { title, includeToc, embedFonts });
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
