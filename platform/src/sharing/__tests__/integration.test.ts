import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SharePermissions, ShareRecord, SharedFileEntry } from '../service.js';

/**
 * Integration tests for file-sharing flows.
 *
 * These tests simulate stateful database interactions using an in-memory store
 * behind the mocked pool.query, then exercise multiple service functions in
 * sequence to verify end-to-end behaviour.
 */

// --- In-memory data stores ---

interface InMemoryStore {
  users: Map<string, { id: string; email: string; display_name: string }>;
  files: Map<string, { id: string; user_id: string; name: string; mime_type: string; size_bytes: number; s3_key: string; folder_id: string | null; created_at: string; updated_at: string }>;
  shares: Map<string, { id: string; file_id: string; owner_id: string; invitee_id: string; perm_edit: boolean; perm_download: boolean; perm_print: boolean; perm_copy: boolean; perm_comment: boolean; perm_review: boolean; perm_chat: boolean; perm_fill_forms: boolean; created_at: string }>;
}

let store: InMemoryStore;

function resetStore() {
  store = {
    users: new Map(),
    files: new Map(),
    shares: new Map(),
  };
}

// --- Mock the DB pool with a stateful in-memory store ---

vi.mock('../../db/pool.js', () => ({
  pool: {
    query: vi.fn(),
  },
}));

// Mock config for buildEditorConfig
vi.mock('../../config.js', () => ({
  config: {
    PLATFORM_BASE_URL: 'http://localhost:3000',
    DS_JWT_SECRET: 'test-secret-key-minimum-8',
  },
}));

// Mock jsonwebtoken to avoid real signing
vi.mock('jsonwebtoken', () => ({
  default: {
    sign: vi.fn((payload: unknown) => `signed-token-${JSON.stringify(payload).slice(0, 20)}`),
    verify: vi.fn(),
  },
}));

import { pool } from '../../db/pool.js';
import {
  createShare,
  getShare,
  listSharedFiles,
  revokeShare,
  deleteSharesForFile,
} from '../service.js';
import { buildEditorConfig } from '../../ds/editorConfig.js';

const mockQuery = pool.query as ReturnType<typeof vi.fn>;

// --- Helper to seed in-memory data ---

function seedUser(id: string, email: string, displayName: string) {
  store.users.set(id, { id, email, display_name: displayName });
}

function seedFile(id: string, userId: string, name: string, updatedAt: string = '2024-06-15T10:00:00Z') {
  store.files.set(id, {
    id,
    user_id: userId,
    name,
    mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size_bytes: 2048,
    s3_key: `${userId}/${id}`,
    folder_id: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: updatedAt,
  });
}

let shareIdCounter = 0;

function addShareToStore(
  fileId: string,
  ownerId: string,
  inviteeId: string,
  permissions: SharePermissions,
  createdAt: string = new Date().toISOString()
): string {
  shareIdCounter++;
  const id = `share-${shareIdCounter}`;
  store.shares.set(id, {
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
  });
  return id;
}

/**
 * Configure the mock query to respond based on the in-memory store.
 * This simulates the database behaviour by pattern-matching SQL queries.
 */
function configureMockQuery() {
  mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
    const query = sql.trim();

    // SELECT user_id FROM files WHERE id = $1
    if (query.startsWith('SELECT user_id FROM files WHERE id')) {
      const fileId = params?.[0] as string;
      const file = store.files.get(fileId);
      return Promise.resolve({ rows: file ? [{ user_id: file.user_id }] : [] });
    }

    // SELECT id FROM users WHERE email = $1
    if (query.startsWith('SELECT id FROM users WHERE email')) {
      const email = params?.[0] as string;
      for (const user of store.users.values()) {
        if (user.email === email) {
          return Promise.resolve({ rows: [{ id: user.id }] });
        }
      }
      return Promise.resolve({ rows: [] });
    }

    // SELECT id FROM file_shares WHERE file_id = $1 AND invitee_id = $2 (duplicate check)
    if (query.startsWith('SELECT id FROM file_shares WHERE file_id')) {
      const fileId = params?.[0] as string;
      const inviteeId = params?.[1] as string;
      for (const share of store.shares.values()) {
        if (share.file_id === fileId && share.invitee_id === inviteeId) {
          return Promise.resolve({ rows: [{ id: share.id }] });
        }
      }
      return Promise.resolve({ rows: [] });
    }

    // INSERT INTO file_shares
    if (query.startsWith('INSERT INTO file_shares')) {
      const [fileId, ownerId, inviteeId, edit, download, print, copy, comment, review, chat, fillForms] = params as [string, string, string, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean];
      shareIdCounter++;
      const id = `share-${shareIdCounter}`;
      const createdAt = new Date().toISOString();
      const row = {
        id,
        file_id: fileId,
        owner_id: ownerId,
        invitee_id: inviteeId,
        perm_edit: edit,
        perm_download: download,
        perm_print: print,
        perm_copy: copy,
        perm_comment: comment,
        perm_review: review,
        perm_chat: chat,
        perm_fill_forms: fillForms,
        created_at: createdAt,
      };
      store.shares.set(id, row);
      return Promise.resolve({ rows: [row] });
    }

    // SELECT * FROM file_shares WHERE file_id = $1 AND invitee_id = $2 (getShare)
    if (query.startsWith('SELECT * FROM file_shares WHERE file_id = $1 AND invitee_id = $2')) {
      const fileId = params?.[0] as string;
      const inviteeId = params?.[1] as string;
      for (const share of store.shares.values()) {
        if (share.file_id === fileId && share.invitee_id === inviteeId) {
          return Promise.resolve({ rows: [share] });
        }
      }
      return Promise.resolve({ rows: [] });
    }

    // SELECT fs.*, f.name ... (listSharedFiles)
    if (query.includes('FROM file_shares fs') && query.includes('JOIN files f')) {
      const inviteeId = params?.[0] as string;
      const results: unknown[] = [];
      for (const share of store.shares.values()) {
        if (share.invitee_id === inviteeId) {
          const file = store.files.get(share.file_id);
          const owner = store.users.get(share.owner_id);
          if (file && owner) {
            results.push({
              ...share,
              file_name: file.name,
              file_type: file.mime_type,
              owner_display_name: owner.display_name,
            });
          }
        }
      }
      // Sort by created_at DESC
      results.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      return Promise.resolve({ rows: results });
    }

    // SELECT owner_id FROM file_shares WHERE id = $1 (revokeShare ownership check)
    if (query.startsWith('SELECT owner_id FROM file_shares WHERE id')) {
      const shareId = params?.[0] as string;
      const share = store.shares.get(shareId);
      return Promise.resolve({ rows: share ? [{ owner_id: share.owner_id }] : [] });
    }

    // DELETE FROM file_shares WHERE id = $1
    if (query === 'DELETE FROM file_shares WHERE id = $1') {
      const shareId = params?.[0] as string;
      store.shares.delete(shareId);
      return Promise.resolve({ rows: [] });
    }

    // DELETE FROM file_shares WHERE file_id = $1
    if (query === 'DELETE FROM file_shares WHERE file_id = $1') {
      const fileId = params?.[0] as string;
      for (const [id, share] of store.shares.entries()) {
        if (share.file_id === fileId) {
          store.shares.delete(id);
        }
      }
      return Promise.resolve({ rows: [] });
    }

    // Default: return empty result
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  shareIdCounter = 0;
  configureMockQuery();
});

// Feature: file-sharing, Task 9.1: End-to-end sharing flow
describe('Integration: End-to-end sharing flow', () => {
  it('owner shares file → invitee sees in listing → invitee opens in editor → co-editing uses same document key', async () => {
    // Setup: create users and a file
    const ownerId = 'owner-001';
    const inviteeId = 'invitee-001';
    const fileId = 'file-001';
    const fileUpdatedAt = '2024-06-15T10:00:00Z';

    seedUser(ownerId, 'owner@example.com', 'Owner User');
    seedUser(inviteeId, 'invitee@example.com', 'Invitee User');
    seedFile(fileId, ownerId, 'project-report.docx', fileUpdatedAt);

    const permissions: SharePermissions = {
      edit: true,
      download: true,
      print: true,
      copy: false,
      comment: true,
      review: false,
      chat: true,
      fillForms: false,
    };

    // Step 1: Owner creates the share
    const shareRecord = await createShare(fileId, ownerId, 'invitee@example.com', permissions);

    expect(shareRecord).toBeDefined();
    expect(shareRecord.fileId).toBe(fileId);
    expect(shareRecord.ownerId).toBe(ownerId);
    expect(shareRecord.inviteeId).toBe(inviteeId);
    expect(shareRecord.permissions).toEqual(permissions);

    // Step 2: Invitee sees the file in their shared files listing
    const sharedFiles = await listSharedFiles(inviteeId);

    expect(sharedFiles).toHaveLength(1);
    expect(sharedFiles[0].fileId).toBe(fileId);
    expect(sharedFiles[0].fileName).toBe('project-report.docx');
    expect(sharedFiles[0].ownerDisplayName).toBe('Owner User');
    expect(sharedFiles[0].permissions).toEqual(permissions);

    // Step 3: Both owner and invitee open in editor — document keys must match
    const file = store.files.get(fileId)!;
    const fileRecord = {
      id: file.id,
      name: file.name,
      mimeType: file.mime_type,
      sizeBytes: file.size_bytes,
      userId: file.user_id,
      folderId: file.folder_id,
      s3Key: file.s3_key,
      createdAt: new Date(file.created_at),
      updatedAt: new Date(file.updated_at),
    };

    // Owner opens file (no sharePermissions)
    const ownerConfig = buildEditorConfig({
      file: fileRecord,
      user: { id: ownerId, name: 'Owner User' },
    }) as any;

    // Invitee opens file (with sharePermissions)
    const inviteeConfig = buildEditorConfig({
      file: fileRecord,
      user: { id: inviteeId, name: 'Invitee User' },
      sharePermissions: permissions,
    }) as any;

    // Document keys MUST be identical for co-editing
    expect(ownerConfig.document.key).toBe(inviteeConfig.document.key);
    expect(ownerConfig.document.key).toBe(`${fileId}_${new Date(fileUpdatedAt).getTime()}`);

    // Owner should have edit mode, invitee with edit=true should also have edit mode
    expect(ownerConfig.editorConfig.mode).toBe('edit');
    expect(inviteeConfig.editorConfig.mode).toBe('edit');

    // Invitee config should reflect share permissions
    expect(inviteeConfig.document.permissions.edit).toBe(true);
    expect(inviteeConfig.document.permissions.copy).toBe(false);
    expect(inviteeConfig.document.permissions.review).toBe(false);
  });

  it('invitee with edit=false gets view mode but same document key', async () => {
    const ownerId = 'owner-002';
    const inviteeId = 'invitee-002';
    const fileId = 'file-002';
    const fileUpdatedAt = '2024-08-01T12:30:00Z';

    seedUser(ownerId, 'owner2@example.com', 'Owner Two');
    seedUser(inviteeId, 'viewer@example.com', 'Viewer User');
    seedFile(fileId, ownerId, 'readonly-doc.xlsx', fileUpdatedAt);

    const viewOnlyPermissions: SharePermissions = {
      edit: false,
      download: true,
      print: true,
      copy: true,
      comment: false,
      review: false,
      chat: false,
      fillForms: false,
    };

    // Owner shares with view-only permissions
    await createShare(fileId, ownerId, 'viewer@example.com', viewOnlyPermissions);

    // Both open the file
    const file = store.files.get(fileId)!;
    const fileRecord = {
      id: file.id,
      name: file.name,
      mimeType: file.mime_type,
      sizeBytes: file.size_bytes,
      userId: file.user_id,
      folderId: file.folder_id,
      s3Key: file.s3_key,
      createdAt: new Date(file.created_at),
      updatedAt: new Date(file.updated_at),
    };

    const ownerConfig = buildEditorConfig({
      file: fileRecord,
      user: { id: ownerId, name: 'Owner Two' },
    }) as any;

    const inviteeConfig = buildEditorConfig({
      file: fileRecord,
      user: { id: inviteeId, name: 'Viewer User' },
      sharePermissions: viewOnlyPermissions,
    }) as any;

    // Same document key
    expect(ownerConfig.document.key).toBe(inviteeConfig.document.key);

    // Invitee with edit=false gets view mode
    expect(inviteeConfig.editorConfig.mode).toBe('view');
    expect(ownerConfig.editorConfig.mode).toBe('edit');
  });
});

// Feature: file-sharing, Task 9.2: Revocation flow
describe('Integration: Revocation flow', () => {
  it('owner revokes share → invitee can no longer access the file', async () => {
    const ownerId = 'owner-010';
    const inviteeId = 'invitee-010';
    const fileId = 'file-010';

    seedUser(ownerId, 'owner10@example.com', 'Owner Ten');
    seedUser(inviteeId, 'invitee10@example.com', 'Invitee Ten');
    seedFile(fileId, ownerId, 'shared-doc.docx');

    const permissions: SharePermissions = {
      edit: true,
      download: true,
      print: false,
      copy: false,
      comment: true,
      review: false,
      chat: false,
      fillForms: false,
    };

    // Step 1: Owner creates the share
    const shareRecord = await createShare(fileId, ownerId, 'invitee10@example.com', permissions);
    expect(shareRecord).toBeDefined();

    // Verify invitee can see the file
    const sharedBefore = await listSharedFiles(inviteeId);
    expect(sharedBefore).toHaveLength(1);

    // Verify getShare returns the share
    const shareBefore = await getShare(fileId, inviteeId);
    expect(shareBefore).not.toBeNull();
    expect(shareBefore!.id).toBe(shareRecord.id);

    // Step 2: Owner revokes the share
    await revokeShare(shareRecord.id, ownerId);

    // Step 3: Invitee can no longer access the file
    const shareAfter = await getShare(fileId, inviteeId);
    expect(shareAfter).toBeNull();

    // Invitee's shared files listing no longer includes the file
    const sharedAfter = await listSharedFiles(inviteeId);
    expect(sharedAfter).toHaveLength(0);
  });

  it('revoking one share does not affect other shares for the same file', async () => {
    const ownerId = 'owner-011';
    const invitee1Id = 'invitee-011a';
    const invitee2Id = 'invitee-011b';
    const fileId = 'file-011';

    seedUser(ownerId, 'owner11@example.com', 'Owner Eleven');
    seedUser(invitee1Id, 'alice@example.com', 'Alice');
    seedUser(invitee2Id, 'bob@example.com', 'Bob');
    seedFile(fileId, ownerId, 'team-doc.docx');

    const permissions: SharePermissions = {
      edit: true,
      download: true,
      print: true,
      copy: true,
      comment: true,
      review: true,
      chat: true,
      fillForms: true,
    };

    // Share with both users
    const share1 = await createShare(fileId, ownerId, 'alice@example.com', permissions);
    const share2 = await createShare(fileId, ownerId, 'bob@example.com', permissions);

    // Revoke Alice's share
    await revokeShare(share1.id, ownerId);

    // Alice can no longer access
    const aliceShare = await getShare(fileId, invitee1Id);
    expect(aliceShare).toBeNull();

    // Bob still has access
    const bobShare = await getShare(fileId, invitee2Id);
    expect(bobShare).not.toBeNull();
    expect(bobShare!.id).toBe(share2.id);
  });
});

// Feature: file-sharing, Task 9.3: File deletion cascade
describe('Integration: File deletion cascade', () => {
  it('owner deletes file → all shares for that file are removed', async () => {
    const ownerId = 'owner-020';
    const invitee1Id = 'invitee-020a';
    const invitee2Id = 'invitee-020b';
    const invitee3Id = 'invitee-020c';
    const fileId = 'file-020';

    seedUser(ownerId, 'owner20@example.com', 'Owner Twenty');
    seedUser(invitee1Id, 'user-a@example.com', 'User A');
    seedUser(invitee2Id, 'user-b@example.com', 'User B');
    seedUser(invitee3Id, 'user-c@example.com', 'User C');
    seedFile(fileId, ownerId, 'multi-shared.docx');

    const permissions: SharePermissions = {
      edit: true,
      download: true,
      print: true,
      copy: true,
      comment: true,
      review: true,
      chat: true,
      fillForms: true,
    };

    // Share with three users
    await createShare(fileId, ownerId, 'user-a@example.com', permissions);
    await createShare(fileId, ownerId, 'user-b@example.com', permissions);
    await createShare(fileId, ownerId, 'user-c@example.com', permissions);

    // Verify all three shares exist
    const shareA = await getShare(fileId, invitee1Id);
    const shareB = await getShare(fileId, invitee2Id);
    const shareC = await getShare(fileId, invitee3Id);
    expect(shareA).not.toBeNull();
    expect(shareB).not.toBeNull();
    expect(shareC).not.toBeNull();

    // Step: Owner deletes the file → deleteSharesForFile is called
    await deleteSharesForFile(fileId);

    // All shares should be removed
    const shareAAfter = await getShare(fileId, invitee1Id);
    const shareBAfter = await getShare(fileId, invitee2Id);
    const shareCAfter = await getShare(fileId, invitee3Id);
    expect(shareAAfter).toBeNull();
    expect(shareBAfter).toBeNull();
    expect(shareCAfter).toBeNull();

    // Invitees' shared files listings are empty for this file
    const filesA = await listSharedFiles(invitee1Id);
    const filesB = await listSharedFiles(invitee2Id);
    const filesC = await listSharedFiles(invitee3Id);
    expect(filesA.filter(f => f.fileId === fileId)).toHaveLength(0);
    expect(filesB.filter(f => f.fileId === fileId)).toHaveLength(0);
    expect(filesC.filter(f => f.fileId === fileId)).toHaveLength(0);
  });

  it('deleting shares for one file does not affect shares for other files', async () => {
    const ownerId = 'owner-021';
    const inviteeId = 'invitee-021';
    const fileId1 = 'file-021a';
    const fileId2 = 'file-021b';

    seedUser(ownerId, 'owner21@example.com', 'Owner TwentyOne');
    seedUser(inviteeId, 'shared-user@example.com', 'Shared User');
    seedFile(fileId1, ownerId, 'file-one.docx');
    seedFile(fileId2, ownerId, 'file-two.docx');

    const permissions: SharePermissions = {
      edit: true,
      download: false,
      print: false,
      copy: false,
      comment: false,
      review: false,
      chat: false,
      fillForms: false,
    };

    // Share both files with the invitee
    await createShare(fileId1, ownerId, 'shared-user@example.com', permissions);
    await createShare(fileId2, ownerId, 'shared-user@example.com', permissions);

    // Delete shares for file 1 only
    await deleteSharesForFile(fileId1);

    // File 1 share should be gone
    const share1 = await getShare(fileId1, inviteeId);
    expect(share1).toBeNull();

    // File 2 share should still exist
    const share2 = await getShare(fileId2, inviteeId);
    expect(share2).not.toBeNull();

    // Invitee's listing only shows file 2
    const sharedFiles = await listSharedFiles(inviteeId);
    expect(sharedFiles).toHaveLength(1);
    expect(sharedFiles[0].fileId).toBe(fileId2);
  });
});
