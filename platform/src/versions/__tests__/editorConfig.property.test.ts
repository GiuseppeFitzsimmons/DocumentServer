import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';

vi.mock('jsonwebtoken', () => ({
  default: { sign: vi.fn(() => 'mock-jwt-token') },
}));

vi.mock('../../config.js', () => ({
  config: {
    PLATFORM_BASE_URL: 'http://localhost:3000',
    DS_JWT_SECRET: 'test-secret-key-12345',
  },
}));

import { buildEditorConfig } from '../../ds/editorConfig.js';
import type { FileRecord } from '../../storage/metadata.js';
import type { SharePermissions } from '../../sharing/service.js';

const fileRecordArb: fc.Arbitrary<FileRecord> = fc.record({
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

const userArb = fc.record({
  id: fc.uuid(),
  name: fc.string({ minLength: 1, maxLength: 30 }),
});

const validPermissionsArb: fc.Arbitrary<SharePermissions> = fc
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
  .filter(
    (p) => p.edit || p.download || p.print || p.copy || p.comment || p.review || p.chat || p.fillForms
  );

// Feature: file-versions, Property 7: Editor config includes history handlers for versioned files
describe('Property 7: Editor config includes history handlers for versioned files', () => {
  it('for any file with versions, editor config includes all four history event handlers for owners', () => {
    fc.assert(
      fc.property(
        fileRecordArb,
        userArb,
        (file, user) => {
          const result = buildEditorConfig({ file, user, hasVersions: true }) as any;

          expect(result.editorConfig.events).toBeDefined();
          expect(result.editorConfig.events.onRequestHistory).toBe(true);
          expect(result.editorConfig.events.onRequestHistoryData).toBe(true);
          expect(result.editorConfig.events.onRequestHistoryClose).toBe(true);
          expect(result.editorConfig.events.onRequestRestore).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('for any file with versions, editor config includes all four history event handlers for shared users', () => {
    fc.assert(
      fc.property(
        fileRecordArb,
        userArb,
        validPermissionsArb,
        (file, user, sharePermissions) => {
          const result = buildEditorConfig({
            file,
            user,
            sharePermissions,
            hasVersions: true,
          }) as any;

          expect(result.editorConfig.events).toBeDefined();
          expect(result.editorConfig.events.onRequestHistory).toBe(true);
          expect(result.editorConfig.events.onRequestHistoryData).toBe(true);
          expect(result.editorConfig.events.onRequestHistoryClose).toBe(true);
          expect(result.editorConfig.events.onRequestRestore).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('for any file without versions, editor config does not include events', () => {
    fc.assert(
      fc.property(
        fileRecordArb,
        userArb,
        (file, user) => {
          const result = buildEditorConfig({ file, user, hasVersions: false }) as any;
          expect(result.editorConfig.events).toBeUndefined();
        }
      ),
      { numRuns: 100 }
    );
  });
});
