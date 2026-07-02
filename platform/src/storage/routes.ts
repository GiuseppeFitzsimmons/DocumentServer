import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import path from 'path';
import { requireAuth } from '../auth/middleware.js';
import * as storage from './s3.js';
import * as metadata from './metadata.js';
import { getTemplate, isValidDocumentType } from './templates.js';
import { getShare, deleteSharesForFile } from '../sharing/service.js';
import * as versionRepo from '../versions/repository.js';
import { pool } from '../db/pool.js';
import { sendEmail } from '../email.js';
import { getAccountUsage, ACCOUNT_QUOTA_BYTES, QUOTA_WARNING_THRESHOLD } from './quota.js';

// Must match the callback handler's MAX_SAVE_SIZE_BYTES
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2mb

// Allowed MIME types for upload
const ALLOWED_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       // .xlsx
  'application/vnd.oasis.opendocument.text',          // .odt
  'application/vnd.oasis.opendocument.spreadsheet',   // .ods
  'application/pdf',
  'text/plain',
  'text/html',
  'application/rtf',
]);

// Allowed file extensions
const ALLOWED_EXTENSIONS = new Set([
  '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp',
  '.pdf', '.txt', '.html', '.htm', '.rtf',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

export const fileRouter = Router();
export const folderRouter = Router();

// All routes require authentication
fileRouter.use(requireAuth);
folderRouter.use(requireAuth);

// --- File endpoints ---

// POST /api/files/upload
fileRouter.post('/upload', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err && err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: `File too large. Maximum size is ${Math.round(MAX_FILE_SIZE / 1024)} KB` });
      return;
    }
    if (err) {
      next(err);
      return;
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    // Validate file extension
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      res.status(400).json({ error: `File type '${ext}' is not allowed` });
      return;
    }

    // Validate MIME type
    if (!ALLOWED_MIME_TYPES.has(req.file.mimetype)) {
      res.status(400).json({ error: 'File type not supported' });
      return;
    }

    // Sanitize filename: remove path components, limit length
    const baseName = path.basename(req.file.originalname).replace(/[^\w\s.\-()]/g, '').trim();
    const sanitizedName = baseName.length > 200 ? baseName.slice(0, 200) + ext : baseName || `document${ext}`;

    const userId = req.session.userId!;
    const fileId = randomUUID();
    const s3Key = `${userId}/${fileId}`;
    const folderId = (req.body.folderId as string) || null;

    // If folderId provided, verify ownership
    if (folderId) {
      const folder = await metadata.getFolder(folderId);
      if (!folder) {
        res.status(404).json({ error: 'Parent folder not found' });
        return;
      }
      if (folder.userId !== userId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
    }

    await storage.upload(s3Key, req.file.buffer, req.file.mimetype);

    const fileRecord = await metadata.createFile({
      name: sanitizedName,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      userId,
      folderId,
      s3Key,
    });

    res.status(201).json(fileRecord);
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Storage error' });
  }
});

// GET /api/files/quota — get account storage usage
fileRouter.get('/quota', async (req, res) => {
  try {
    const userId = req.session.userId!;
    const quota = await getAccountUsage(userId);
    res.json(quota);
  } catch (err) {
    console.error('Quota check error:', err);
    res.status(500).json({ error: 'Failed to check quota' });
  }
});

// POST /api/files/create — create a new blank document
fileRouter.post('/create', async (req, res) => {
  try {
    const userId = req.session.userId!;
    const { type, name, folderId } = req.body;

    if (!type || !isValidDocumentType(type)) {
      res.status(400).json({ error: 'Invalid type. Must be docx, xlsx, or pptx' });
      return;
    }

    // Check account quota
    const quota = await getAccountUsage(userId);
    if (quota.isFull) {
      res.status(413).json({ error: 'Account storage is full. Delete some files to free up space.', quota });
      return;
    }

    const fileName = name ? `${name}.${type}` : `Untitled.${type}`;
    const template = getTemplate(type);
    const fileId = randomUUID();
    const s3Key = `${userId}/${fileId}`;

    // Verify folder ownership if provided
    if (folderId) {
      const folder = await metadata.getFolder(folderId);
      if (!folder) {
        res.status(404).json({ error: 'Parent folder not found' });
        return;
      }
      if (folder.userId !== userId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
    }

    await storage.upload(s3Key, template.buffer, template.mimeType);

    const fileRecord = await metadata.createFile({
      name: fileName,
      mimeType: template.mimeType,
      sizeBytes: template.buffer.length,
      userId,
      folderId: folderId || null,
      s3Key,
    });

    // Include quota warning if approaching limit
    const updatedQuota = await getAccountUsage(userId);
    res.status(201).json({ ...fileRecord, quota: updatedQuota.isWarning ? updatedQuota : undefined });
  } catch (err) {
    console.error('Create document error:', err);
    res.status(500).json({ error: 'Storage error' });
  }
});

// POST /api/files/saveas — save a copy of a document from DS URL
fileRouter.post('/saveas', async (req, res) => {
  try {
    const userId = req.session.userId!;
    const { title, url, fileId } = req.body;

    if (!url || !title) {
      res.status(400).json({ error: 'Title and URL are required' });
      return;
    }

    // Fetch the file from DS
    const response = await fetch(url);
    if (!response.ok) {
      res.status(502).json({ error: 'Failed to fetch document from server' });
      return;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || 'application/octet-stream';

    // Determine folder from original file
    let folderId: string | null = null;
    if (fileId) {
      const original = await metadata.getFile(fileId);
      if (original && original.userId === userId) {
        folderId = original.folderId;
      }
    }

    const newFileId = randomUUID();
    const s3Key = `${userId}/${newFileId}`;
    await storage.upload(s3Key, buffer, contentType);

    const fileRecord = await metadata.createFile({
      name: title,
      mimeType: contentType,
      sizeBytes: buffer.length,
      userId,
      folderId,
      s3Key,
    });

    res.status(201).json(fileRecord);
  } catch (err) {
    console.error('Save As error:', err);
    res.status(500).json({ error: 'Storage error' });
  }
});

// GET /api/files/:id/download
fileRouter.get('/:id/download', async (req, res) => {
  try {
    const userId = req.session.userId!;
    const file = await metadata.getFile(req.params.id);

    if (!file) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    // If user is not owner, check share record for download permission
    if (file.userId !== userId) {
      const share = await getShare(file.id, userId);
      if (!share || !share.permissions.download) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
    }

    const stream = await storage.download(file.s3Key);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
    stream.pipe(res);
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Storage error' });
  }
});

// POST /api/files/:id/email-to-me — email the file to the current user
fileRouter.post('/:id/email-to-me', async (req, res) => {
  try {
    const userId = req.session.userId!;
    const file = await metadata.getFile(req.params.id);

    if (!file) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    // Check access: owner or shared with download permission
    if (file.userId !== userId) {
      const share = await getShare(file.id, userId);
      if (!share || !share.permissions.download) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
    }

    // Get user's email
    const userResult = await pool.query(
      'SELECT email, display_name FROM users WHERE id = $1',
      [userId]
    );
    if (userResult.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const userEmail = userResult.rows[0].email;
    const userName = userResult.rows[0].display_name;

    // Download the file from storage
    const stream = await storage.download(file.s3Key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const fileBuffer = Buffer.concat(chunks);

    await sendEmail({
      to: userEmail,
      subject: `Your document: ${file.name}`,
      text: `Hi ${userName},\n\nHere is your document "${file.name}" from Euro Bureau.\n\nBest regards,\nEuro Bureau`,
      html: `<p>Hi ${userName},</p><p>Here is your document "<strong>${file.name}</strong>" from Euro Bureau.</p><p>Best regards,<br>Euro Bureau</p>`,
      attachments: [{
        filename: file.name,
        content: fileBuffer,
        contentType: file.mimeType,
      }],
    });

    res.json({ success: true, email: userEmail });
  } catch (err) {
    console.error('Email-to-me error:', err);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// PATCH /api/files/:id
fileRouter.patch('/:id', async (req, res) => {
  try {
    const userId = req.session.userId!;
    const file = await metadata.getFile(req.params.id);

    if (!file) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (file.userId !== userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const updates: Partial<Pick<metadata.FileRecord, 'name' | 'folderId'>> = {};

    if (req.body.touch) {
      // Just update the timestamp to generate a new document key
      await pool.query('UPDATE files SET updated_at = NOW() WHERE id = $1', [file.id]);
      const refreshed = await metadata.getFile(file.id);
      res.json(refreshed);
      return;
    }

    if (req.body.name) {
      updates.name = req.body.name;
    }
    if (req.body.folderId !== undefined) {
      // Verify target folder ownership
      if (req.body.folderId !== null) {
        const targetFolder = await metadata.getFolder(req.body.folderId);
        if (!targetFolder) {
          res.status(404).json({ error: 'Target folder not found' });
          return;
        }
        if (targetFolder.userId !== userId) {
          res.status(403).json({ error: 'Forbidden' });
          return;
        }
      }
      updates.folderId = req.body.folderId;
    }

    const updated = await metadata.updateFile(file.id, updates);
    res.json(updated);
  } catch (err) {
    console.error('File update error:', err);
    res.status(500).json({ error: 'Storage error' });
  }
});

// DELETE /api/files/:id
fileRouter.delete('/:id', async (req, res) => {
  try {
    const userId = req.session.userId!;
    const file = await metadata.getFile(req.params.id);

    if (!file) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (file.userId !== userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    // Fetch version keys before DB cascade deletes them
    const versions = await versionRepo.listVersions(file.id);

    await metadata.deleteFile(file.id);
    await storage.remove(file.s3Key);
    await deleteSharesForFile(file.id);

    // Clean up version blobs from storage
    for (const v of versions) {
      await storage.remove(v.s3Key);
      if (v.changesS3Key) {
        await storage.remove(v.changesS3Key);
      }
    }
    res.status(204).end();
  } catch (err) {
    console.error('File delete error:', err);
    res.status(500).json({ error: 'Storage error' });
  }
});

// GET /api/files?folderId=
fileRouter.get('/', async (req, res) => {
  try {
    const userId = req.session.userId!;
    const folderId = (req.query.folderId as string) || null;

    // If folderId provided, verify ownership
    if (folderId) {
      const folder = await metadata.getFolder(folderId);
      if (!folder) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (folder.userId !== userId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
    }

    const contents = await metadata.listFolder(userId, folderId);

    const items = [
      ...contents.folders.map(f => ({
        id: f.id,
        name: f.name,
        type: 'folder' as const,
        size: null,
        mimeType: null,
        updatedAt: f.updatedAt,
      })),
      ...contents.files.map(f => ({
        id: f.id,
        name: f.name,
        type: 'file' as const,
        size: f.sizeBytes,
        mimeType: f.mimeType,
        updatedAt: f.updatedAt,
      })),
    ];

    res.json(items);
  } catch (err) {
    console.error('List folder error:', err);
    res.status(500).json({ error: 'Storage error' });
  }
});

// --- Folder endpoints ---

// POST /api/folders
folderRouter.post('/', async (req, res) => {
  try {
    const userId = req.session.userId!;
    const { name, parentId } = req.body;

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'Folder name is required' });
      return;
    }

    // If parentId provided, verify ownership
    if (parentId) {
      const parent = await metadata.getFolder(parentId);
      if (!parent) {
        res.status(404).json({ error: 'Parent folder not found' });
        return;
      }
      if (parent.userId !== userId) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
    }

    const folder = await metadata.createFolder({
      name,
      userId,
      parentId: parentId || null,
    });

    res.status(201).json(folder);
  } catch (err) {
    console.error('Create folder error:', err);
    res.status(500).json({ error: 'Storage error' });
  }
});

// GET /api/folders/tree
folderRouter.get('/tree', async (req, res) => {
  try {
    const userId = req.session.userId!;
    const folders = await metadata.getAllUserFolders(userId);

    // Build a nested tree structure in memory
    interface FolderTreeNode {
      id: string;
      name: string;
      parentId: string | null;
      children: FolderTreeNode[];
    }

    const nodeMap = new Map<string, FolderTreeNode>();

    // Create a node for each folder
    for (const folder of folders) {
      nodeMap.set(folder.id, {
        id: folder.id,
        name: folder.name,
        parentId: folder.parentId,
        children: [],
      });
    }

    // Assemble the tree by linking children to parents
    const roots: FolderTreeNode[] = [];
    for (const node of nodeMap.values()) {
      if (node.parentId && nodeMap.has(node.parentId)) {
        nodeMap.get(node.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    res.json(roots);
  } catch (err) {
    console.error('Folder tree error:', err);
    res.status(500).json({ error: 'Storage error' });
  }
});

// GET /api/folders/:id/children
folderRouter.get('/:id/children', async (req, res) => {
  try {
    const userId = req.session.userId!;
    const folderId = req.params.id;

    // If "root", return top-level folders (parentId = null)
    if (folderId === 'root') {
      const contents = await metadata.listFolder(userId, null);
      res.json(contents.folders);
      return;
    }

    // Verify folder exists and belongs to user
    const folder = await metadata.getFolder(folderId);
    if (!folder) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (folder.userId !== userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    // Get direct child folders
    const contents = await metadata.listFolder(userId, folderId);
    res.json(contents.folders);
  } catch (err) {
    console.error('Folder children error:', err);
    res.status(500).json({ error: 'Storage error' });
  }
});

// GET /api/folders/:id/ancestors
folderRouter.get('/:id/ancestors', async (req, res) => {
  try {
    const userId = req.session.userId!;
    const folderId = req.params.id;

    // Verify folder exists and belongs to user
    const folder = await metadata.getFolder(folderId);
    if (!folder) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (folder.userId !== userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    // Get the ancestor chain (ordered from root ancestor to the folder itself)
    const ancestors = await metadata.getAncestors(folderId);

    // Map to { id, name } objects and prepend the root entry
    const result = [
      { id: null, name: 'My Files' },
      ...ancestors.map(a => ({ id: a.id, name: a.name })),
    ];

    res.json(result);
  } catch (err) {
    console.error('Folder ancestors error:', err);
    res.status(500).json({ error: 'Storage error' });
  }
});

// GET /api/folders/:id
folderRouter.get('/:id', async (req, res) => {
  try {
    const userId = req.session.userId!;
    const folder = await metadata.getFolder(req.params.id);

    if (!folder) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (folder.userId !== userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    res.json(folder);
  } catch (err) {
    console.error('Get folder error:', err);
    res.status(500).json({ error: 'Storage error' });
  }
});

// PATCH /api/folders/:id
folderRouter.patch('/:id', async (req, res) => {
  try {
    const userId = req.session.userId!;
    const folder = await metadata.getFolder(req.params.id);

    if (!folder) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (folder.userId !== userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    // Handle move (parentId provided)
    if (req.body.parentId !== undefined) {
      // Reject self-referential move
      if (req.body.parentId === req.params.id) {
        res.status(400).json({ error: 'Cannot move folder into itself' });
        return;
      }

      // If parentId is not null, verify target folder exists and belongs to user
      if (req.body.parentId !== null) {
        const targetFolder = await metadata.getFolder(req.body.parentId);
        if (!targetFolder) {
          res.status(404).json({ error: 'Target folder not found' });
          return;
        }
        if (targetFolder.userId !== userId) {
          res.status(403).json({ error: 'Forbidden' });
          return;
        }

        // Check for circular reference
        const isCircular = await metadata.isDescendantOf(req.body.parentId, folder.id);
        if (isCircular) {
          res.status(400).json({ error: 'Cannot move folder into its own descendant' });
          return;
        }
      }

      const updated = await metadata.moveFolder(folder.id, req.body.parentId);
      res.json(updated);
      return;
    }

    // Handle rename (name provided)
    if (req.body.name && typeof req.body.name === 'string') {
      const updated = await metadata.renameFolder(folder.id, req.body.name);
      res.json(updated);
      return;
    }

    // Neither name nor parentId provided
    res.status(400).json({ error: 'Folder name is required' });
  } catch (err) {
    console.error('Rename folder error:', err);
    res.status(500).json({ error: 'Storage error' });
  }
});

// DELETE /api/folders/:id
folderRouter.delete('/:id', async (req, res) => {
  try {
    const userId = req.session.userId!;
    const folder = await metadata.getFolder(req.params.id);

    if (!folder) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (folder.userId !== userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    await metadata.deleteFolder(folder.id);
    res.status(204).end();
  } catch (err: any) {
    if (err.statusCode === 409) {
      res.status(409).json({ error: 'Folder is not empty' });
      return;
    }
    console.error('Delete folder error:', err);
    res.status(500).json({ error: 'Storage error' });
  }
});
