import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
// Mock the database pool
vi.mock('../../db/pool.js', () => ({
    pool: {
        query: vi.fn(),
    },
}));
import { pool } from '../../db/pool.js';
import { createShare, getShare, listSharesForFile, updateSharePermissions, revokeShare, deleteSharesForFile, } from '../service.js';
const mockQuery = pool.query;
// --- Generators ---
/** Generates a valid SharePermissions object with at least one flag true */
const validPermissionsArb = fc
    .record({
    edit: fc.boolean(),
    download: fc.boolean(),
    print: fc.boolean(),
    copy: fc.boolean(),
    comment: fc.boolean(),
    review: fc.boolean(),
    chat: fc.boolean(),
    fillForms: fc.boolean(),
})
    .filter((p) => p.edit || p.download || p.print || p.copy || p.comment || p.review || p.chat || p.fillForms);
/** Generates a SharePermissions object with ALL flags false */
const allFalsePermissionsArb = fc.constant({
    edit: false,
    download: false,
    print: false,
    copy: false,
    comment: false,
    review: false,
    chat: false,
    fillForms: false,
});
/** Generates a UUID-like string */
const uuidArb = fc.uuid();
/** Generates a realistic email */
const emailArb = fc.emailAddress();
// --- Helper to build a DB row from share data ---
function buildShareRow(id, fileId, ownerId, inviteeId, permissions, createdAt = '2024-01-01T00:00:00Z') {
    return {
        id,
        file_id: fileId,
        owner_id: ownerId,
        invitee_id: inviteeId,
        perm_edit: permissions.edit,
        perm_download: permissions.download,
        perm_print: permissions.print,
        perm_copy: permissions.copy,
        perm_comment: permissions.comment,
        perm_review: permissions.review,
        perm_chat: permissions.chat,
        perm_fill_forms: permissions.fillForms,
        created_at: createdAt,
    };
}
beforeEach(() => {
    mockQuery.mockReset();
});
// Feature: file-sharing, Property 1: Share creation preserves permissions
describe('Property 1: Share creation preserves permissions', () => {
    it('creating a share and reading it back yields exact same permission flags', async () => {
        await fc.assert(fc.asyncProperty(uuidArb, uuidArb, uuidArb, emailArb, validPermissionsArb, async (fileId, ownerId, inviteeId, inviteeEmail, permissions) => {
            mockQuery.mockReset();
            const shareId = 'share-id-001';
            const createdAt = '2024-06-15T10:00:00Z';
            // Mock: file ownership check
            mockQuery.mockResolvedValueOnce({ rows: [{ user_id: ownerId }] });
            // Mock: invitee lookup by email
            mockQuery.mockResolvedValueOnce({ rows: [{ id: inviteeId }] });
            // Mock: duplicate check - no existing share
            mockQuery.mockResolvedValueOnce({ rows: [] });
            // Mock: INSERT RETURNING
            mockQuery.mockResolvedValueOnce({
                rows: [buildShareRow(shareId, fileId, ownerId, inviteeId, permissions, createdAt)],
            });
            const result = await createShare(fileId, ownerId, inviteeEmail, permissions);
            expect(result.permissions.edit).toBe(permissions.edit);
            expect(result.permissions.download).toBe(permissions.download);
            expect(result.permissions.print).toBe(permissions.print);
            expect(result.permissions.copy).toBe(permissions.copy);
            expect(result.permissions.comment).toBe(permissions.comment);
            expect(result.permissions.review).toBe(permissions.review);
            expect(result.permissions.chat).toBe(permissions.chat);
            expect(result.permissions.fillForms).toBe(permissions.fillForms);
            expect(result.fileId).toBe(fileId);
            expect(result.ownerId).toBe(ownerId);
            expect(result.inviteeId).toBe(inviteeId);
        }), { numRuns: 100 });
    });
});
// Feature: file-sharing, Property 2: Non-existent invitee email is rejected
describe('Property 2: Non-existent invitee email is rejected', () => {
    it('creating a share with a non-registered email fails with 404', async () => {
        await fc.assert(fc.asyncProperty(uuidArb, uuidArb, emailArb, validPermissionsArb, async (fileId, ownerId, inviteeEmail, permissions) => {
            mockQuery.mockReset();
            // Mock: file ownership check passes
            mockQuery.mockResolvedValueOnce({ rows: [{ user_id: ownerId }] });
            // Mock: invitee lookup returns empty (user not found)
            mockQuery.mockResolvedValueOnce({ rows: [] });
            try {
                await createShare(fileId, ownerId, inviteeEmail, permissions);
                // Should not reach here
                expect.fail('Expected createShare to throw');
            }
            catch (err) {
                const error = err;
                expect(error.statusCode).toBe(404);
                expect(error.message).toBe('User not found');
            }
        }), { numRuns: 100 });
    });
});
// Feature: file-sharing, Property 3: Non-owner cannot manage shares
describe('Property 3: Non-owner cannot manage shares', () => {
    it('non-owner attempting to create a share returns 403', async () => {
        await fc.assert(fc.asyncProperty(uuidArb, uuidArb, uuidArb, emailArb, validPermissionsArb, async (fileId, ownerId, actualOwnerId, inviteeEmail, permissions) => {
            fc.pre(ownerId !== actualOwnerId);
            mockQuery.mockReset();
            // Mock: file ownership check - user is NOT the owner
            mockQuery.mockResolvedValueOnce({ rows: [{ user_id: actualOwnerId }] });
            try {
                await createShare(fileId, ownerId, inviteeEmail, permissions);
                expect.fail('Expected createShare to throw');
            }
            catch (err) {
                const error = err;
                expect(error.statusCode).toBe(403);
                expect(error.message).toBe('Forbidden');
            }
        }), { numRuns: 100 });
    });
    it('non-owner attempting to revoke a share returns 403', async () => {
        await fc.assert(fc.asyncProperty(uuidArb, uuidArb, uuidArb, async (shareId, requesterId, actualOwnerId) => {
            fc.pre(requesterId !== actualOwnerId);
            mockQuery.mockReset();
            // Mock: share exists with different owner
            mockQuery.mockResolvedValueOnce({ rows: [{ owner_id: actualOwnerId }] });
            try {
                await revokeShare(shareId, requesterId);
                expect.fail('Expected revokeShare to throw');
            }
            catch (err) {
                const error = err;
                expect(error.statusCode).toBe(403);
                expect(error.message).toBe('Forbidden');
            }
        }), { numRuns: 100 });
    });
    it('non-owner attempting to list shares for a file returns 403', async () => {
        await fc.assert(fc.asyncProperty(uuidArb, uuidArb, uuidArb, async (fileId, requesterId, actualOwnerId) => {
            fc.pre(requesterId !== actualOwnerId);
            mockQuery.mockReset();
            // Mock: file ownership check - user is NOT the owner
            mockQuery.mockResolvedValueOnce({ rows: [{ user_id: actualOwnerId }] });
            try {
                await listSharesForFile(fileId, requesterId);
                expect.fail('Expected listSharesForFile to throw');
            }
            catch (err) {
                const error = err;
                expect(error.statusCode).toBe(403);
                expect(error.message).toBe('Forbidden');
            }
        }), { numRuns: 100 });
    });
});
// Feature: file-sharing, Property 4: Duplicate share is rejected
describe('Property 4: Duplicate share is rejected', () => {
    it('creating a share for an already-shared file+invitee pair fails with 409', async () => {
        await fc.assert(fc.asyncProperty(uuidArb, uuidArb, uuidArb, emailArb, validPermissionsArb, async (fileId, ownerId, inviteeId, inviteeEmail, permissions) => {
            fc.pre(ownerId !== inviteeId);
            mockQuery.mockReset();
            // Mock: file ownership check passes
            mockQuery.mockResolvedValueOnce({ rows: [{ user_id: ownerId }] });
            // Mock: invitee lookup succeeds
            mockQuery.mockResolvedValueOnce({ rows: [{ id: inviteeId }] });
            // Mock: duplicate check - share already exists
            mockQuery.mockResolvedValueOnce({ rows: [{ id: 'existing-share-id' }] });
            try {
                await createShare(fileId, ownerId, inviteeEmail, permissions);
                expect.fail('Expected createShare to throw');
            }
            catch (err) {
                const error = err;
                expect(error.statusCode).toBe(409);
                expect(error.message).toBe('Share already exists');
            }
        }), { numRuns: 100 });
    });
});
// Feature: file-sharing, Property 5: At least one permission required
describe('Property 5: At least one permission required', () => {
    it('creating a share with all permissions false is rejected with 400', async () => {
        await fc.assert(fc.asyncProperty(uuidArb, uuidArb, emailArb, allFalsePermissionsArb, async (fileId, ownerId, inviteeEmail, permissions) => {
            mockQuery.mockReset();
            try {
                await createShare(fileId, ownerId, inviteeEmail, permissions);
                expect.fail('Expected createShare to throw');
            }
            catch (err) {
                const error = err;
                expect(error.statusCode).toBe(400);
                expect(error.message).toBe('At least one permission must be granted');
            }
        }), { numRuns: 100 });
    });
});
// Feature: file-sharing, Property 6: Permission update round-trip
describe('Property 6: Permission update round-trip', () => {
    it('updating permissions and reading back yields exact new values', async () => {
        await fc.assert(fc.asyncProperty(uuidArb, uuidArb, validPermissionsArb, async (shareId, ownerId, newPermissions) => {
            mockQuery.mockReset();
            // Mock: share exists and belongs to ownerId
            mockQuery.mockResolvedValueOnce({
                rows: [{ id: shareId, owner_id: ownerId, file_id: 'file-1', invitee_id: 'inv-1' }],
            });
            // Mock: UPDATE RETURNING
            mockQuery.mockResolvedValueOnce({
                rows: [
                    buildShareRow(shareId, 'file-1', ownerId, 'inv-1', newPermissions, '2024-01-01T00:00:00Z'),
                ],
            });
            const result = await updateSharePermissions(shareId, ownerId, newPermissions);
            expect(result.permissions.edit).toBe(newPermissions.edit);
            expect(result.permissions.download).toBe(newPermissions.download);
            expect(result.permissions.print).toBe(newPermissions.print);
            expect(result.permissions.copy).toBe(newPermissions.copy);
            expect(result.permissions.comment).toBe(newPermissions.comment);
            expect(result.permissions.review).toBe(newPermissions.review);
            expect(result.permissions.chat).toBe(newPermissions.chat);
            expect(result.permissions.fillForms).toBe(newPermissions.fillForms);
        }), { numRuns: 100 });
    });
});
// Feature: file-sharing, Property 11: Revoke removes share
describe('Property 11: Revoke removes share', () => {
    it('after owner revokes a share, querying that share returns null', async () => {
        await fc.assert(fc.asyncProperty(uuidArb, uuidArb, uuidArb, uuidArb, async (shareId, fileId, ownerId, inviteeId) => {
            mockQuery.mockReset();
            // Step 1: Revoke the share
            // Mock: share exists and belongs to owner
            mockQuery.mockResolvedValueOnce({ rows: [{ owner_id: ownerId }] });
            // Mock: DELETE succeeds
            mockQuery.mockResolvedValueOnce({ rows: [] });
            await revokeShare(shareId, ownerId);
            // Step 2: Query the share - should return null
            mockQuery.mockResolvedValueOnce({ rows: [] });
            const result = await getShare(fileId, inviteeId);
            expect(result).toBeNull();
        }), { numRuns: 100 });
    });
});
// Feature: file-sharing, Property 14: File deletion cascades to shares
describe('Property 14: File deletion cascades to shares', () => {
    it('after calling deleteSharesForFile, no shares remain for that file ID', async () => {
        await fc.assert(fc.asyncProperty(uuidArb, async (fileId) => {
            mockQuery.mockReset();
            // Mock: DELETE all shares for the file
            mockQuery.mockResolvedValueOnce({ rows: [] });
            await deleteSharesForFile(fileId);
            // Verify the delete query was called with the correct file ID
            expect(mockQuery).toHaveBeenCalledWith('DELETE FROM file_shares WHERE file_id = $1', [fileId]);
        }), { numRuns: 100 });
    });
});
//# sourceMappingURL=service.test.js.map