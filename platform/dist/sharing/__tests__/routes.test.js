import { describe, it, expect, vi, beforeEach } from 'vitest';
// Mock the sharing service
vi.mock('../service.js', () => ({
    createShare: vi.fn(),
    listSharesForFile: vi.fn(),
    listSharedFiles: vi.fn(),
    updateSharePermissions: vi.fn(),
    revokeShare: vi.fn(),
    getShare: vi.fn(),
    deleteSharesForFile: vi.fn(),
}));
// Mock the storage metadata module
vi.mock('../../storage/metadata.js', () => ({
    getFile: vi.fn(),
}));
// Mock the storage s3 module
vi.mock('../../storage/s3.js', () => ({
    download: vi.fn(),
}));
// Mock the DB pool (used by editor route)
vi.mock('../../db/pool.js', () => ({
    pool: {
        query: vi.fn(),
    },
}));
// Mock the editor config builder
vi.mock('../../ds/editorConfig.js', () => ({
    buildEditorConfig: vi.fn(() => ({})),
}));
// Mock the auth middleware to pass through with a configurable userId
vi.mock('../../auth/middleware.js', () => ({
    requireAuth: (req, _res, next) => {
        // userId is set on req.session in our test setup
        next();
    },
}));
// Mock the versions repository (used by editor route)
vi.mock('../../versions/repository.js', () => ({
    getLatestVersionNumber: vi.fn(() => Promise.resolve(0)),
}));
import * as sharingService from '../service.js';
import { getFile } from '../../storage/metadata.js';
import { download } from '../../storage/s3.js';
import { pool } from '../../db/pool.js';
// --- Test helpers ---
function createMockReq(overrides = {}) {
    const req = {
        params: {},
        body: {},
        query: {},
        headers: { accept: 'application/json' },
        path: '/api/shares',
        session: { userId: 'user-1' },
        ...overrides,
    };
    return req;
}
function createMockRes() {
    const res = {
        _status: undefined,
        _json: undefined,
        _ended: false,
        _headers: {},
    };
    res.status = vi.fn((code) => {
        res._status = code;
        return res;
    });
    res.json = vi.fn((data) => {
        res._json = data;
        return res;
    });
    res.end = vi.fn(() => {
        res._ended = true;
        return res;
    });
    res.setHeader = vi.fn((name, value) => {
        res._headers[name] = value;
        return res;
    });
    res.render = vi.fn();
    res.redirect = vi.fn();
    return res;
}
/**
 * Helper to extract and invoke a route handler from the sharing router.
 * We import the router and walk its stack to find the handler we need.
 */
async function invokeRouteHandler(router, method, path, req, res) {
    // Express router stack contains layers with route objects
    const layers = router.stack || [];
    for (const layer of layers) {
        if (layer.route) {
            const route = layer.route;
            if (route.path === path && route.methods[method.toLowerCase()]) {
                const handlers = route.stack.map((s) => s.handle);
                for (const handler of handlers) {
                    await handler(req, res, () => { });
                }
                return;
            }
        }
    }
    throw new Error(`Route not found: ${method} ${path}`);
}
beforeEach(() => {
    vi.clearAllMocks();
});
// Feature: file-sharing, Property 3: Non-owner cannot manage shares
describe('Property 3: Non-owner cannot manage shares', () => {
    it('POST /api/shares returns 403 when user is not the file owner', async () => {
        const { sharingRouter } = await import('../routes.js');
        const forbiddenError = Object.assign(new Error('Forbidden'), { statusCode: 403 });
        sharingService.createShare.mockRejectedValueOnce(forbiddenError);
        const req = createMockReq({
            body: {
                fileId: 'file-1',
                email: 'other@example.com',
                permissions: { edit: true, download: false, print: false, copy: false, comment: false, review: false, chat: false, fillForms: false },
            },
            session: { userId: 'non-owner-user' },
        });
        const res = createMockRes();
        await invokeRouteHandler(sharingRouter, 'POST', '/', req, res);
        expect(res._status).toBe(403);
        expect(res._json).toEqual({ error: 'Forbidden' });
    });
    it('DELETE /api/shares/:shareId returns 403 when user is not the share owner', async () => {
        const { sharingRouter } = await import('../routes.js');
        const forbiddenError = Object.assign(new Error('Forbidden'), { statusCode: 403 });
        sharingService.revokeShare.mockRejectedValueOnce(forbiddenError);
        const req = createMockReq({
            params: { shareId: 'share-1' },
            session: { userId: 'non-owner-user' },
        });
        const res = createMockRes();
        await invokeRouteHandler(sharingRouter, 'DELETE', '/:shareId', req, res);
        expect(res._status).toBe(403);
        expect(res._json).toEqual({ error: 'Forbidden' });
    });
    it('GET /api/shares/file/:fileId returns 403 when user is not the file owner', async () => {
        const { sharingRouter } = await import('../routes.js');
        const forbiddenError = Object.assign(new Error('Forbidden'), { statusCode: 403 });
        sharingService.listSharesForFile.mockRejectedValueOnce(forbiddenError);
        const req = createMockReq({
            params: { fileId: 'file-1' },
            session: { userId: 'non-owner-user' },
        });
        const res = createMockRes();
        await invokeRouteHandler(sharingRouter, 'GET', '/file/:fileId', req, res);
        expect(res._status).toBe(403);
        expect(res._json).toEqual({ error: 'Forbidden' });
    });
    it('PATCH /api/shares/:shareId returns 403 when user is not the share owner', async () => {
        const { sharingRouter } = await import('../routes.js');
        const forbiddenError = Object.assign(new Error('Forbidden'), { statusCode: 403 });
        sharingService.updateSharePermissions.mockRejectedValueOnce(forbiddenError);
        const req = createMockReq({
            params: { shareId: 'share-1' },
            body: { permissions: { edit: true, download: false, print: false, copy: false, comment: false, review: false, chat: false, fillForms: false } },
            session: { userId: 'non-owner-user' },
        });
        const res = createMockRes();
        await invokeRouteHandler(sharingRouter, 'PATCH', '/:shareId', req, res);
        expect(res._status).toBe(403);
        expect(res._json).toEqual({ error: 'Forbidden' });
    });
});
// Feature: file-sharing, Property 10: Unauthorized file access rejected
describe('Property 10: Unauthorized file access rejected', () => {
    it('GET /editor/:fileId returns 403 when user is neither owner nor has a share', async () => {
        const { editorRouter } = await import('../../pages/editor.js');
        const userId = 'stranger-user';
        const fileId = 'file-123';
        const ownerId = 'owner-user';
        // Mock: getFile returns a file owned by someone else
        getFile.mockResolvedValueOnce({
            id: fileId,
            name: 'test.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            sizeBytes: 1024,
            userId: ownerId,
            folderId: null,
            s3Key: `${ownerId}/${fileId}`,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        // Mock: pool.query for current user display name
        pool.query.mockResolvedValueOnce({
            rows: [{ display_name: 'Stranger User' }],
        });
        // Mock: pool.query for owner display name
        pool.query.mockResolvedValueOnce({
            rows: [{ display_name: 'Owner User' }],
        });
        // Mock: listSharesForFile returns empty array
        sharingService.listSharesForFile.mockResolvedValueOnce([]);
        // Mock: no share record exists
        sharingService.getShare.mockResolvedValueOnce(null);
        const req = createMockReq({
            params: { fileId },
            session: { userId },
        });
        const res = createMockRes();
        await invokeRouteHandler(editorRouter, 'GET', '/editor/:fileId', req, res);
        expect(res._status).toBe(403);
        expect(res._json).toEqual({ error: 'Forbidden' });
    });
    it('GET /editor/:fileId returns 404 when file does not exist', async () => {
        const { editorRouter } = await import('../../pages/editor.js');
        getFile.mockResolvedValueOnce(null);
        const req = createMockReq({
            params: { fileId: 'non-existent-file' },
            session: { userId: 'user-1' },
        });
        const res = createMockRes();
        await invokeRouteHandler(editorRouter, 'GET', '/editor/:fileId', req, res);
        expect(res._status).toBe(404);
        expect(res._json).toEqual({ error: 'Not found' });
    });
    it('GET /editor/:fileId allows access when user has a share record', async () => {
        const { editorRouter } = await import('../../pages/editor.js');
        const userId = 'invitee-user';
        const fileId = 'file-456';
        const ownerId = 'owner-user';
        // Mock: getFile returns a file owned by someone else
        getFile.mockResolvedValueOnce({
            id: fileId,
            name: 'shared.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            sizeBytes: 2048,
            userId: ownerId,
            folderId: null,
            s3Key: `${ownerId}/${fileId}`,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        // Mock: pool.query for current user display name
        pool.query.mockResolvedValueOnce({
            rows: [{ display_name: 'Invitee User' }],
        });
        // Mock: pool.query for owner display name
        pool.query.mockResolvedValueOnce({
            rows: [{ display_name: 'Owner User' }],
        });
        // Mock: listSharesForFile returns shares
        sharingService.listSharesForFile.mockResolvedValueOnce([{
                id: 'share-1',
                fileId,
                ownerId,
                inviteeId: userId,
                inviteeDisplayName: 'Invitee User',
                permissions: { edit: true, download: true, print: true, copy: true, comment: true, review: true, chat: true, fillForms: true },
                createdAt: new Date(),
            }]);
        // Mock: share record exists (for access check)
        sharingService.getShare.mockResolvedValueOnce({
            id: 'share-1',
            fileId,
            ownerId,
            inviteeId: userId,
            permissions: { edit: true, download: true, print: true, copy: true, comment: true, review: true, chat: true, fillForms: true },
            createdAt: new Date(),
        });
        const req = createMockReq({
            params: { fileId },
            session: { userId },
        });
        const res = createMockRes();
        await invokeRouteHandler(editorRouter, 'GET', '/editor/:fileId', req, res);
        // Should render (not return 403)
        expect(res._status).not.toBe(403);
        expect(res.render).toHaveBeenCalled();
    });
});
// Feature: file-sharing, Property 12: Download gated by permission flag
describe('Property 12: Download gated by permission flag', () => {
    it('GET /api/files/:id/download returns 403 when share exists but download=false', async () => {
        const { fileRouter } = await import('../../storage/routes.js');
        const userId = 'invitee-user';
        const fileId = 'file-789';
        const ownerId = 'owner-user';
        // Mock: getFile returns a file owned by someone else
        getFile.mockResolvedValueOnce({
            id: fileId,
            name: 'restricted.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            sizeBytes: 4096,
            userId: ownerId,
            folderId: null,
            s3Key: `${ownerId}/${fileId}`,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        // Mock: share exists but download is false
        sharingService.getShare.mockResolvedValueOnce({
            id: 'share-2',
            fileId,
            ownerId,
            inviteeId: userId,
            permissions: { edit: true, download: false, print: true, copy: true, comment: true, review: true, chat: true, fillForms: true },
            createdAt: new Date(),
        });
        const req = createMockReq({
            params: { id: fileId },
            session: { userId },
        });
        const res = createMockRes();
        await invokeRouteHandler(fileRouter, 'GET', '/:id/download', req, res);
        expect(res._status).toBe(403);
        expect(res._json).toEqual({ error: 'Forbidden' });
    });
    it('GET /api/files/:id/download returns 403 when no share exists for non-owner', async () => {
        const { fileRouter } = await import('../../storage/routes.js');
        const userId = 'stranger-user';
        const fileId = 'file-aaa';
        const ownerId = 'owner-user';
        getFile.mockResolvedValueOnce({
            id: fileId,
            name: 'private.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            sizeBytes: 1024,
            userId: ownerId,
            folderId: null,
            s3Key: `${ownerId}/${fileId}`,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        // Mock: no share record
        sharingService.getShare.mockResolvedValueOnce(null);
        const req = createMockReq({
            params: { id: fileId },
            session: { userId },
        });
        const res = createMockRes();
        await invokeRouteHandler(fileRouter, 'GET', '/:id/download', req, res);
        expect(res._status).toBe(403);
        expect(res._json).toEqual({ error: 'Forbidden' });
    });
    it('GET /api/files/:id/download succeeds when share exists with download=true', async () => {
        const { fileRouter } = await import('../../storage/routes.js');
        const userId = 'invitee-user';
        const fileId = 'file-bbb';
        const ownerId = 'owner-user';
        getFile.mockResolvedValueOnce({
            id: fileId,
            name: 'downloadable.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            sizeBytes: 2048,
            userId: ownerId,
            folderId: null,
            s3Key: `${ownerId}/${fileId}`,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        // Mock: share exists with download=true
        sharingService.getShare.mockResolvedValueOnce({
            id: 'share-3',
            fileId,
            ownerId,
            inviteeId: userId,
            permissions: { edit: false, download: true, print: false, copy: false, comment: false, review: false, chat: false, fillForms: false },
            createdAt: new Date(),
        });
        // Mock: s3 download returns a stream
        const mockStream = { pipe: vi.fn() };
        download.mockResolvedValueOnce(mockStream);
        const req = createMockReq({
            params: { id: fileId },
            session: { userId },
        });
        const res = createMockRes();
        await invokeRouteHandler(fileRouter, 'GET', '/:id/download', req, res);
        // Should NOT return 403 — download should proceed
        expect(res._status).not.toBe(403);
        expect(mockStream.pipe).toHaveBeenCalledWith(res);
    });
});
// Feature: file-sharing, Property 13: Invitees cannot rename, move, or delete
describe('Property 13: Invitees cannot rename, move, or delete', () => {
    it('PATCH /api/files/:id (rename) returns 403 for invitee even with all permissions', async () => {
        const { fileRouter } = await import('../../storage/routes.js');
        const userId = 'invitee-user';
        const fileId = 'file-ccc';
        const ownerId = 'owner-user';
        getFile.mockResolvedValueOnce({
            id: fileId,
            name: 'original.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            sizeBytes: 1024,
            userId: ownerId,
            folderId: null,
            s3Key: `${ownerId}/${fileId}`,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        const req = createMockReq({
            params: { id: fileId },
            body: { name: 'renamed.docx' },
            session: { userId },
        });
        const res = createMockRes();
        await invokeRouteHandler(fileRouter, 'PATCH', '/:id', req, res);
        expect(res._status).toBe(403);
        expect(res._json).toEqual({ error: 'Forbidden' });
    });
    it('PATCH /api/files/:id (move) returns 403 for invitee even with all permissions', async () => {
        const { fileRouter } = await import('../../storage/routes.js');
        const userId = 'invitee-user';
        const fileId = 'file-ddd';
        const ownerId = 'owner-user';
        getFile.mockResolvedValueOnce({
            id: fileId,
            name: 'movable.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            sizeBytes: 1024,
            userId: ownerId,
            folderId: null,
            s3Key: `${ownerId}/${fileId}`,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        const req = createMockReq({
            params: { id: fileId },
            body: { folderId: 'some-folder-id' },
            session: { userId },
        });
        const res = createMockRes();
        await invokeRouteHandler(fileRouter, 'PATCH', '/:id', req, res);
        expect(res._status).toBe(403);
        expect(res._json).toEqual({ error: 'Forbidden' });
    });
    it('DELETE /api/files/:id returns 403 for invitee even with all permissions', async () => {
        const { fileRouter } = await import('../../storage/routes.js');
        const userId = 'invitee-user';
        const fileId = 'file-eee';
        const ownerId = 'owner-user';
        getFile.mockResolvedValueOnce({
            id: fileId,
            name: 'deletable.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            sizeBytes: 1024,
            userId: ownerId,
            folderId: null,
            s3Key: `${ownerId}/${fileId}`,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        const req = createMockReq({
            params: { id: fileId },
            session: { userId },
        });
        const res = createMockRes();
        await invokeRouteHandler(fileRouter, 'DELETE', '/:id', req, res);
        expect(res._status).toBe(403);
        expect(res._json).toEqual({ error: 'Forbidden' });
    });
});
//# sourceMappingURL=routes.test.js.map