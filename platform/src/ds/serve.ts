import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import * as storage from '../storage/s3.js';
import * as metadata from '../storage/metadata.js';

export const serveRouter = Router();

// GET /api/files/serve/:token
// No session auth — JWT is the auth mechanism for DS-to-platform communication
serveRouter.get('/:token', async (req, res) => {
  try {
    const payload = jwt.verify(req.params.token, config.DS_JWT_SECRET) as { fileId: string };

    const file = await metadata.getFile(payload.fileId);
    if (!file) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const stream = await storage.download(file.s3Key);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
    stream.pipe(res);
  } catch (err: any) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    console.error('Serve file error:', err);
    res.status(500).json({ error: 'Storage error' });
  }
});
