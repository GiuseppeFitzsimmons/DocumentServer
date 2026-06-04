import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { requireAuth } from '../auth/middleware.js';
import * as storage from './s3.js';
import * as metadata from './metadata.js';
import { getTemplate, isValidDocumentType } from './templates.js';
import { getShare, deleteSharesForFile } from '../sharing/service.js';
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
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
            res.status(413).json({ error: 'File too large. Maximum size is 50 MB' });
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
        const userId = req.session.userId;
        const fileId = randomUUID();
        const s3Key = `${userId}/${fileId}`;
        const folderId = req.body.folderId || null;
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
            name: req.file.originalname,
            mimeType: req.file.mimetype,
            sizeBytes: req.file.size,
            userId,
            folderId,
            s3Key,
        });
        res.status(201).json(fileRecord);
    }
    catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({ error: 'Storage error' });
    }
});
// POST /api/files/create — create a new blank document
fileRouter.post('/create', async (req, res) => {
    try {
        const userId = req.session.userId;
        const { type, name, folderId } = req.body;
        if (!type || !isValidDocumentType(type)) {
            res.status(400).json({ error: 'Invalid type. Must be docx, xlsx, or pptx' });
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
        res.status(201).json(fileRecord);
    }
    catch (err) {
        console.error('Create document error:', err);
        res.status(500).json({ error: 'Storage error' });
    }
});
// POST /api/files/saveas — save a copy of a document from DS URL
fileRouter.post('/saveas', async (req, res) => {
    try {
        const userId = req.session.userId;
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
        let folderId = null;
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
    }
    catch (err) {
        console.error('Save As error:', err);
        res.status(500).json({ error: 'Storage error' });
    }
});
// GET /api/files/:id/download
fileRouter.get('/:id/download', async (req, res) => {
    try {
        const userId = req.session.userId;
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
    }
    catch (err) {
        console.error('Download error:', err);
        res.status(500).json({ error: 'Storage error' });
    }
});
// PATCH /api/files/:id
fileRouter.patch('/:id', async (req, res) => {
    try {
        const userId = req.session.userId;
        const file = await metadata.getFile(req.params.id);
        if (!file) {
            res.status(404).json({ error: 'Not found' });
            return;
        }
        if (file.userId !== userId) {
            res.status(403).json({ error: 'Forbidden' });
            return;
        }
        const updates = {};
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
    }
    catch (err) {
        console.error('File update error:', err);
        res.status(500).json({ error: 'Storage error' });
    }
});
// DELETE /api/files/:id
fileRouter.delete('/:id', async (req, res) => {
    try {
        const userId = req.session.userId;
        const file = await metadata.getFile(req.params.id);
        if (!file) {
            res.status(404).json({ error: 'Not found' });
            return;
        }
        if (file.userId !== userId) {
            res.status(403).json({ error: 'Forbidden' });
            return;
        }
        await metadata.deleteFile(file.id);
        await storage.remove(file.s3Key);
        await deleteSharesForFile(file.id);
        res.status(204).end();
    }
    catch (err) {
        console.error('File delete error:', err);
        res.status(500).json({ error: 'Storage error' });
    }
});
// GET /api/files?folderId=
fileRouter.get('/', async (req, res) => {
    try {
        const userId = req.session.userId;
        const folderId = req.query.folderId || null;
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
                type: 'folder',
                size: null,
                mimeType: null,
                updatedAt: f.updatedAt,
            })),
            ...contents.files.map(f => ({
                id: f.id,
                name: f.name,
                type: 'file',
                size: f.sizeBytes,
                mimeType: f.mimeType,
                updatedAt: f.updatedAt,
            })),
        ];
        res.json(items);
    }
    catch (err) {
        console.error('List folder error:', err);
        res.status(500).json({ error: 'Storage error' });
    }
});
// --- Folder endpoints ---
// POST /api/folders
folderRouter.post('/', async (req, res) => {
    try {
        const userId = req.session.userId;
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
    }
    catch (err) {
        console.error('Create folder error:', err);
        res.status(500).json({ error: 'Storage error' });
    }
});
// GET /api/folders/:id
folderRouter.get('/:id', async (req, res) => {
    try {
        const userId = req.session.userId;
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
    }
    catch (err) {
        console.error('Get folder error:', err);
        res.status(500).json({ error: 'Storage error' });
    }
});
// PATCH /api/folders/:id
folderRouter.patch('/:id', async (req, res) => {
    try {
        const userId = req.session.userId;
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
    }
    catch (err) {
        console.error('Rename folder error:', err);
        res.status(500).json({ error: 'Storage error' });
    }
});
// DELETE /api/folders/:id
folderRouter.delete('/:id', async (req, res) => {
    try {
        const userId = req.session.userId;
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
    }
    catch (err) {
        if (err.statusCode === 409) {
            res.status(409).json({ error: 'Folder is not empty' });
            return;
        }
        console.error('Delete folder error:', err);
        res.status(500).json({ error: 'Storage error' });
    }
});
//# sourceMappingURL=routes.js.map