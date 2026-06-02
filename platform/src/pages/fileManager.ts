import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { listFolder } from '../storage/metadata.js';

export const fileManagerRouter = Router();

fileManagerRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const userId = req.session.userId!;
    const { files, folders } = await listFolder(userId, null);

    const items = [
      ...folders.map(f => ({
        id: f.id,
        name: f.name,
        type: 'folder' as const,
        size: null,
        mimeType: null,
        updatedAt: f.updatedAt.toISOString(),
      })),
      ...files.map(f => ({
        id: f.id,
        name: f.name,
        type: 'file' as const,
        size: f.sizeBytes,
        mimeType: f.mimeType,
        updatedAt: f.updatedAt.toISOString(),
      })),
    ];

    res.render('file-manager', {
      layout: false,
      items: JSON.stringify(items),
    });
  } catch (err) {
    next(err);
  }
});
