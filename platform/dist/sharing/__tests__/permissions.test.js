import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
// Mock the database pool
vi.mock('../../db/pool.js', () => ({
    pool: {
        query: vi.fn(),
    },
}));
// Mock jsonwebtoken to avoid needing a real secret
vi.mock('jsonwebtoken', () => ({
    default: {
        sign: vi.fn(() => 'mock-jwt-token'),
    },
}));
// Mock the config module
vi.mock('../../config.js', () => ({
    config: {
        PLATFORM_BASE_URL: 'http://localhost:3000',
        DS_JWT_SECRET: 'test-secret-key-12345',
    },
}));
import { pool } from '../../db/pool.js';
import { createShare, updateSharePermissions } from '../service.js';
import { buildEditorConfig } from '../../ds/editorConfig.js';
const mockQuery = pool.query;
// --- Generators ---
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
/** Generates a UUID-like string */
const uuidArb = fc.uuid();
/** Generates a realistic email */
const emailArb = fc.emailAddress();
/** Generates a FileRecord suitable for buildEditorConfig */
const fileRecordArb = fc.record({
    id: fc.uuid(),
    name: fc.stringMatching(/^[a-z]{1,10}\.(docx|xlsx|pptx|pdf|txt)$/),
    mimeType: fc.constant('application/octet-stream'),
    sizeBytes: fc.nat({ max: 100_000_000 }),
    userId: fc.uuid(),
    folderId: fc.option(fc.uuid(), { nil: null }),
    s3Key: fc.string({ minLength: 5, maxLength: 50 }),
    createdAt: fc.date({ min: new Date('2020-01-01'), max: new Date('2025-01-01') }),
    updatedAt: fc.date({ min: new Date('2020-01-01'), max: new Date('2025-01-01') }),
});
/** Generates a user object for buildEditorConfig */
const userArb = fc.record({
    id: fc.uuid(),
    name: fc.string({ minLength: 1, maxLength: 30 }),
});
beforeEach(() => {
    mockQuery.mockReset();
});
// Feature: file-sharing, Property 5: At least one permission required
describe('Property 5: At least one permission required', () => {
    it('createShare rejects all-false permissions with status 400', async () => {
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
    it('updateSharePermissions rejects all-false permissions with status 400', async () => {
        await fc.assert(fc.asyncProperty(uuidArb, uuidArb, allFalsePermissionsArb, async (shareId, ownerId, permissions) => {
            mockQuery.mockReset();
            try {
                await updateSharePermissions(shareId, ownerId, permissions);
                expect.fail('Expected updateSharePermissions to throw');
            }
            catch (err) {
                const error = err;
                expect(error.statusCode).toBe(400);
                expect(error.message).toBe('At least one permission must be granted');
            }
        }), { numRuns: 100 });
    });
});
// Feature: file-sharing, Property 9: Editor config permission mapping
describe('Property 9: Editor config permission mapping', () => {
    it('each SharePermissions flag maps to the corresponding DS permissions field', () => {
        fc.assert(fc.property(fileRecordArb, userArb, validPermissionsArb, (file, user, sharePermissions) => {
            const result = buildEditorConfig({ file, user, sharePermissions });
            // Each permission flag should map directly
            expect(result.document.permissions.edit).toBe(sharePermissions.edit);
            expect(result.document.permissions.download).toBe(sharePermissions.download);
            expect(result.document.permissions.print).toBe(sharePermissions.print);
            expect(result.document.permissions.copy).toBe(sharePermissions.copy);
            expect(result.document.permissions.comment).toBe(sharePermissions.comment);
            expect(result.document.permissions.review).toBe(sharePermissions.review);
            expect(result.document.permissions.chat).toBe(sharePermissions.chat);
            expect(result.document.permissions.fillForms).toBe(sharePermissions.fillForms);
        }), { numRuns: 100 });
    });
    it('editor mode is "view" if and only if edit is false', () => {
        fc.assert(fc.property(fileRecordArb, userArb, validPermissionsArb, (file, user, sharePermissions) => {
            const result = buildEditorConfig({ file, user, sharePermissions });
            if (sharePermissions.edit === false) {
                expect(result.editorConfig.mode).toBe('view');
            }
            else {
                expect(result.editorConfig.mode).toBe('edit');
            }
        }), { numRuns: 100 });
    });
});
//# sourceMappingURL=permissions.test.js.map