import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import * as sharingService from './service.js';
export const sharingRouter = Router();
// All sharing routes require authentication
sharingRouter.use(requireAuth);
// POST /api/shares — Create a share
sharingRouter.post('/', async (req, res) => {
    try {
        const userId = req.session.userId;
        const { fileId, email, permissions } = req.body;
        if (!fileId || !email || !permissions) {
            res.status(400).json({ error: 'fileId, email, and permissions are required' });
            return;
        }
        const share = await sharingService.createShare(fileId, userId, email, {
            edit: permissions.edit ?? false,
            download: permissions.download ?? false,
            print: permissions.print ?? false,
            copy: permissions.copy ?? false,
            comment: permissions.comment ?? false,
            review: permissions.review ?? false,
            chat: permissions.chat ?? false,
            fillForms: permissions.fillForms ?? false,
        });
        res.status(201).json(share);
    }
    catch (err) {
        if (err.statusCode) {
            res.status(err.statusCode).json({ error: err.message });
            return;
        }
        console.error('Create share error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});
// GET /api/shares/file/:fileId — List shares for a file (owner only)
sharingRouter.get('/file/:fileId', async (req, res) => {
    try {
        const userId = req.session.userId;
        const shares = await sharingService.listSharesForFile(req.params.fileId, userId);
        res.json(shares);
    }
    catch (err) {
        if (err.statusCode) {
            res.status(err.statusCode).json({ error: err.message });
            return;
        }
        console.error('List shares error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});
// GET /api/shares/my-files — List files shared with the current user
sharingRouter.get('/my-files', async (req, res) => {
    try {
        const userId = req.session.userId;
        const files = await sharingService.listSharedFiles(userId);
        res.json(files);
    }
    catch (err) {
        if (err.statusCode) {
            res.status(err.statusCode).json({ error: err.message });
            return;
        }
        console.error('List shared files error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});
// PATCH /api/shares/:shareId — Update permissions
sharingRouter.patch('/:shareId', async (req, res) => {
    try {
        const userId = req.session.userId;
        const { permissions } = req.body;
        if (!permissions) {
            res.status(400).json({ error: 'permissions are required' });
            return;
        }
        const updated = await sharingService.updateSharePermissions(req.params.shareId, userId, {
            edit: permissions.edit ?? false,
            download: permissions.download ?? false,
            print: permissions.print ?? false,
            copy: permissions.copy ?? false,
            comment: permissions.comment ?? false,
            review: permissions.review ?? false,
            chat: permissions.chat ?? false,
            fillForms: permissions.fillForms ?? false,
        });
        res.json(updated);
    }
    catch (err) {
        if (err.statusCode) {
            res.status(err.statusCode).json({ error: err.message });
            return;
        }
        console.error('Update share error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});
// DELETE /api/shares/:shareId — Revoke a share
sharingRouter.delete('/:shareId', async (req, res) => {
    try {
        const userId = req.session.userId;
        await sharingService.revokeShare(req.params.shareId, userId);
        res.status(204).end();
    }
    catch (err) {
        if (err.statusCode) {
            res.status(err.statusCode).json({ error: err.message });
            return;
        }
        console.error('Revoke share error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});
//# sourceMappingURL=routes.js.map