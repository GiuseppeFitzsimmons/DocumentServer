import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { requireAuth } from '../auth/middleware.js';
import * as metadata from '../storage/metadata.js';
import * as storage from '../storage/s3.js';
import * as versionRepo from './repository.js';
import { getShare } from '../sharing/service.js';
import { pool } from '../db/pool.js';
import path from 'path';

export const versionRouter = Router();

// Helper: check if user has access to the file (owner or shared)
async function checkFileAccess(fileId: string, userId: string): Promise<{ file: metadata.FileRecord; canEdit: boolean } | null> {
  const file = await metadata.getFile(fileId);
  if (!file) return null;

  if (file.userId === userId) {
    return { file, canEdit: true };
  }

  const share = await getShare(fileId, userId);
  if (!share) return null;

  return { file, canEdit: share.permissions.edit };
}

// GET /api/files/:fileId/versions - List versions
versionRouter.get('/:fileId/versions', requireAuth, async (req, res) => {
  try {
    const fileId = req.params.fileId as string;
    const userId = req.session.userId!;

    const access = await checkFileAccess(fileId, userId);
    if (!access) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const versions = await versionRepo.listVersions(fileId);

    // Get display names for users
    const userIds = [...new Set(versions.map((v) => v.createdBy))];
    const userNames: Record<string, string> = {};
    if (userIds.length > 0) {
      const { rows } = await pool.query(
        `SELECT id, display_name FROM users WHERE id = ANY($1)`,
        [userIds]
      );
      for (const row of rows) {
        userNames[row.id as string] = row.display_name as string;
      }
    }

    // Build current version info from file
    const currentVersion = versions.length > 0 ? versions[0].versionNumber + 1 : 1;

    const history = versions.map((v) => ({
      version: v.versionNumber,
      key: v.documentKey,
      created: v.createdAt.toISOString(),
      user: { id: v.createdBy, name: userNames[v.createdBy] || 'Unknown' },
      changes: v.changesJson,
    }));

    res.json({ currentVersion, history });
  } catch (err) {
    console.error('Version list error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/files/:fileId/versions/:ver/content - Serve archived file (JWT auth for DS)
versionRouter.get('/:fileId/versions/:ver/content', async (req, res) => {
  try {
    const fileId = req.params.fileId as string;
    const ver = req.params.ver as string;
    const token = req.query.token as string;

    if (!token) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      jwt.verify(token, config.DS_JWT_SECRET);
    } catch {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const versionNumber = parseInt(ver, 10);
    const version = await versionRepo.getVersion(fileId, versionNumber);
    if (!version) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const stream = await storage.download(version.s3Key);
    stream.pipe(res);
  } catch (err) {
    console.error('Version content serve error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/files/:fileId/versions/:ver/diff - Serve diff zip (JWT auth for DS)
versionRouter.get('/:fileId/versions/:ver/diff', async (req, res) => {
  try {
    const fileId = req.params.fileId as string;
    const ver = req.params.ver as string;
    const token = req.query.token as string;

    if (!token) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      jwt.verify(token, config.DS_JWT_SECRET);
    } catch {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const versionNumber = parseInt(ver, 10);
    const version = await versionRepo.getVersion(fileId, versionNumber);
    if (!version || !version.changesS3Key) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const stream = await storage.download(version.changesS3Key);
    res.setHeader('Content-Type', 'application/zip');
    stream.pipe(res);
  } catch (err) {
    console.error('Version diff serve error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/files/:fileId/versions/:ver/data - History data for DS
versionRouter.get('/:fileId/versions/:ver/data', requireAuth, async (req, res) => {
  try {
    const fileId = req.params.fileId as string;
    const ver = req.params.ver as string;
    const userId = req.session.userId!;

    const access = await checkFileAccess(fileId, userId);
    if (!access) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const versionNumber = parseInt(ver, 10);
    const version = await versionRepo.getVersion(fileId, versionNumber);
    if (!version) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const file = access.file;
    const fileExt = file.name.includes('.') ? file.name.split('.').pop()! : '';
    const platformBaseUrl = config.PLATFORM_BASE_URL;

    // Generate signed token for DS to fetch version content
    const contentToken = jwt.sign({ fileId, ver: versionNumber }, config.DS_JWT_SECRET, { expiresIn: '1h' });

    const data: Record<string, unknown> = {
      version: versionNumber,
      key: version.documentKey,
      fileType: fileExt,
      url: `${platformBaseUrl}/api/files/${fileId}/versions/${versionNumber}/content?token=${contentToken}`,
    };

    // Add previous version reference if available
    if (versionNumber > 1) {
      const prevVersion = await versionRepo.getVersion(fileId, versionNumber - 1);
      if (prevVersion) {
        const prevToken = jwt.sign({ fileId, ver: versionNumber - 1 }, config.DS_JWT_SECRET, { expiresIn: '1h' });
        data.previous = {
          version: prevVersion.versionNumber,
          key: prevVersion.documentKey,
          fileType: fileExt,
          url: `${platformBaseUrl}/api/files/${fileId}/versions/${prevVersion.versionNumber}/content?token=${prevToken}`,
        };
      }
    }

    // Add changes URL if diff exists
    if (version.changesS3Key) {
      const diffToken = jwt.sign({ fileId, ver: versionNumber }, config.DS_JWT_SECRET, { expiresIn: '1h' });
      data.changesUrl = `${platformBaseUrl}/api/files/${fileId}/versions/${versionNumber}/diff?token=${diffToken}`;
    }

    res.json(data);
  } catch (err) {
    console.error('Version data error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/files/:fileId/versions/:ver/restore - Restore a version
versionRouter.post('/:fileId/versions/:ver/restore', requireAuth, async (req, res) => {
  try {
    const fileId = req.params.fileId as string;
    const ver = req.params.ver as string;
    const userId = req.session.userId!;

    const access = await checkFileAccess(fileId, userId);
    if (!access) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    if (!access.canEdit) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const versionNumber = parseInt(ver, 10);
    const version = await versionRepo.getVersion(fileId, versionNumber);
    if (!version) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const file = access.file;

    // Archive current content as a new version before restore
    const currentStream = await storage.download(file.s3Key);
    const chunks: Buffer[] = [];
    for await (const chunk of currentStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const currentContent = Buffer.concat(chunks);

    const latestVersion = await versionRepo.getLatestVersionNumber(fileId);
    const newVersionNumber = latestVersion + 1;
    const ext = path.extname(file.name);
    const archiveKey = `${file.userId}/${file.id}/versions/${newVersionNumber}${ext}`;

    await storage.upload(archiveKey, currentContent, file.mimeType);

    const documentKey = `${file.id}_${file.updatedAt.getTime()}`;
    await versionRepo.insertVersion({
      fileId: file.id,
      versionNumber: newVersionNumber,
      s3Key: archiveKey,
      sizeBytes: currentContent.length,
      documentKey,
      createdBy: userId,
    });

    // Copy archived version content to current file key
    const versionStream = await storage.download(version.s3Key);
    const versionChunks: Buffer[] = [];
    for await (const chunk of versionStream) {
      versionChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const versionContent = Buffer.concat(versionChunks);

    await storage.upload(file.s3Key, versionContent, file.mimeType);
    await metadata.updateFile(file.id, { sizeBytes: versionContent.length });

    res.json({ success: true });
  } catch (err) {
    console.error('Version restore error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
