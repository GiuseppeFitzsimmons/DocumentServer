import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { Readable } from 'stream';
import { config } from '../config.js';
import * as storage from '../storage/s3.js';
import * as metadata from '../storage/metadata.js';
export const callbackRouter = Router();
// POST /api/ds/callback?fileId=
// Authenticated via DS JWT in Authorization header
callbackRouter.post('/', async (req, res) => {
    try {
        // Verify JWT from DocumentServer
        const authHeader = req.headers.authorization;
        if (!authHeader) {
            res.status(401).json({ error: 'Unauthorized' });
            return;
        }
        const token = authHeader.startsWith('Bearer ')
            ? authHeader.slice(7)
            : authHeader;
        try {
            jwt.verify(token, config.DS_JWT_SECRET);
        }
        catch {
            res.status(401).json({ error: 'Unauthorized' });
            return;
        }
        const { fileId } = req.query;
        if (!fileId) {
            console.warn('Callback missing fileId query param');
            res.json({ error: 1 });
            return;
        }
        const payload = req.body;
        // Only process status 2 (document ready for saving)
        if (payload.status !== 2) {
            res.json({ error: 0 });
            return;
        }
        if (!payload.url) {
            console.warn('Callback status 2 but no URL provided', { fileId });
            res.json({ error: 1 });
            return;
        }
        const file = await metadata.getFile(fileId);
        if (!file) {
            console.error('Callback for non-existent file', { fileId });
            res.json({ error: 1 });
            return;
        }
        // Download the updated document from DS-provided URL
        const response = await fetch(payload.url);
        if (!response.ok || !response.body) {
            console.error('Failed to download from DS URL', {
                fileId,
                url: payload.url,
                status: response.status,
            });
            res.json({ error: 1 });
            return;
        }
        // Convert web ReadableStream to Node Readable
        const nodeStream = Readable.fromWeb(response.body);
        // Buffer the content to get size
        const chunks = [];
        for await (const chunk of nodeStream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const buffer = Buffer.concat(chunks);
        // Upload to S3, replacing previous version
        await storage.upload(file.s3Key, buffer, file.mimeType);
        // Update metadata
        await metadata.updateFile(file.id, { sizeBytes: buffer.length });
        res.json({ error: 0 });
    }
    catch (err) {
        console.error('Callback handler error:', err);
        res.json({ error: 1 });
    }
});
//# sourceMappingURL=callback.js.map