import { describe, it, expect, vi } from 'vitest';

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

const file: FileRecord = {
  id: 'file-1',
  name: 'test.docx',
  mimeType: 'application/octet-stream',
  sizeBytes: 5000,
  userId: 'user-1',
  folderId: null,
  s3Key: 'user-1/file-1/test.docx',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-15'),
};

const user = { id: 'user-1', name: 'John Doe' };

describe('EditorConfig - hasVersions', () => {
  it('includes history events when hasVersions is true', () => {
    const result = buildEditorConfig({ file, user, hasVersions: true }) as any;

    expect(result.editorConfig.events).toBeDefined();
    expect(result.editorConfig.events.onRequestHistory).toBe(true);
    expect(result.editorConfig.events.onRequestHistoryData).toBe(true);
    expect(result.editorConfig.events.onRequestHistoryClose).toBe(true);
    expect(result.editorConfig.events.onRequestRestore).toBe(true);
  });

  it('does not include events when hasVersions is false', () => {
    const result = buildEditorConfig({ file, user, hasVersions: false }) as any;

    expect(result.editorConfig.events).toBeUndefined();
  });

  it('does not include events when hasVersions is not set', () => {
    const result = buildEditorConfig({ file, user }) as any;

    expect(result.editorConfig.events).toBeUndefined();
  });

  it('includes events for shared users with hasVersions true', () => {
    const result = buildEditorConfig({
      file,
      user: { id: 'user-2', name: 'Jane' },
      sharePermissions: { edit: true, download: true, print: true, copy: true, comment: true, review: true, chat: true, fillForms: true },
      hasVersions: true,
    }) as any;

    expect(result.editorConfig.events).toBeDefined();
    expect(result.editorConfig.events.onRequestHistory).toBe(true);
  });
});
