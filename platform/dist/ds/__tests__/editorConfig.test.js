import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
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
import { buildEditorConfig } from '../editorConfig.js';
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
// Feature: file-sharing, Property 8: Document key consistency for co-editing
describe('Property 8: Document key consistency for co-editing', () => {
    it('document key is identical for owner and invitee opening the same file', () => {
        // **Validates: Requirements 4.1, 8.3**
        fc.assert(fc.property(fileRecordArb, userArb, userArb, validPermissionsArb, (file, ownerUser, inviteeUser, sharePermissions) => {
            // Owner opens the file (no sharePermissions)
            const ownerConfig = buildEditorConfig({ file, user: ownerUser });
            // Invitee opens the same file (with sharePermissions)
            const inviteeConfig = buildEditorConfig({
                file,
                user: inviteeUser,
                sharePermissions,
            });
            // Document key must be identical for co-editing to work
            expect(inviteeConfig.document.key).toBe(ownerConfig.document.key);
            // Verify the key is derived from file.id and file.updatedAt
            const expectedKey = `${file.id}_${file.updatedAt.getTime()}`;
            expect(ownerConfig.document.key).toBe(expectedKey);
        }), { numRuns: 100 });
    });
});
// Feature: file-sharing, Property 9: Editor config permission mapping
describe('Property 9: Editor config permission mapping', () => {
    it('each SharePermissions flag maps to the corresponding DS permissions field', () => {
        // **Validates: Requirements 4.2, 4.3**
        fc.assert(fc.property(fileRecordArb, userArb, validPermissionsArb, (file, user, sharePermissions) => {
            const result = buildEditorConfig({ file, user, sharePermissions });
            // Each permission flag should map directly to the DS permissions field
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
        // **Validates: Requirements 4.2, 4.3**
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
//# sourceMappingURL=editorConfig.test.js.map