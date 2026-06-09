import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../db/pool.js', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

import { getLatestVersionNumber, insertVersion, listVersions, getVersion } from '../repository.js';

beforeEach(() => {
  mockQuery.mockReset();
});

describe('getLatestVersionNumber', () => {
  it('returns 0 when no versions exist', async () => {
    mockQuery.mockResolvedValue({ rows: [{ max_version: 0 }] });
    const result = await getLatestVersionNumber('file-1');
    expect(result).toBe(0);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('MAX(version_number)'),
      ['file-1']
    );
  });

  it('returns the maximum version number', async () => {
    mockQuery.mockResolvedValue({ rows: [{ max_version: 5 }] });
    const result = await getLatestVersionNumber('file-1');
    expect(result).toBe(5);
  });
});

describe('insertVersion', () => {
  it('inserts a version record and returns mapped result', async () => {
    const now = new Date().toISOString();
    mockQuery.mockResolvedValue({
      rows: [{
        id: 'ver-1',
        file_id: 'file-1',
        version_number: 1,
        s3_key: 'user/file/versions/1.docx',
        size_bytes: 1024,
        changes_s3_key: null,
        changes_json: null,
        document_key: 'doc-key-1',
        created_by: 'user-1',
        created_at: now,
      }],
    });

    const result = await insertVersion({
      fileId: 'file-1',
      versionNumber: 1,
      s3Key: 'user/file/versions/1.docx',
      sizeBytes: 1024,
      documentKey: 'doc-key-1',
      createdBy: 'user-1',
    });

    expect(result.id).toBe('ver-1');
    expect(result.fileId).toBe('file-1');
    expect(result.versionNumber).toBe(1);
    expect(result.s3Key).toBe('user/file/versions/1.docx');
    expect(result.sizeBytes).toBe(1024);
    expect(result.changesS3Key).toBeNull();
    expect(result.changesJson).toBeNull();
  });

  it('stores changesJson as stringified JSON', async () => {
    const changesData = { changes: [{ field: 'value' }], serverVersion: '7.0' };
    mockQuery.mockResolvedValue({
      rows: [{
        id: 'ver-2',
        file_id: 'file-1',
        version_number: 2,
        s3_key: 'user/file/versions/2.docx',
        size_bytes: 2048,
        changes_s3_key: 'user/file/versions/2/diff.zip',
        changes_json: changesData,
        document_key: 'doc-key-2',
        created_by: 'user-1',
        created_at: new Date().toISOString(),
      }],
    });

    await insertVersion({
      fileId: 'file-1',
      versionNumber: 2,
      s3Key: 'user/file/versions/2.docx',
      sizeBytes: 2048,
      changesS3Key: 'user/file/versions/2/diff.zip',
      changesJson: changesData,
      documentKey: 'doc-key-2',
      createdBy: 'user-1',
    });

    const callArgs = mockQuery.mock.calls[0][1];
    expect(callArgs[5]).toBe(JSON.stringify(changesData));
  });
});

describe('listVersions', () => {
  it('returns versions ordered by version_number descending', async () => {
    const now = new Date().toISOString();
    mockQuery.mockResolvedValue({
      rows: [
        { id: 'v2', file_id: 'f1', version_number: 2, s3_key: 'k2', size_bytes: 200, changes_s3_key: null, changes_json: null, document_key: 'dk2', created_by: 'u1', created_at: now },
        { id: 'v1', file_id: 'f1', version_number: 1, s3_key: 'k1', size_bytes: 100, changes_s3_key: null, changes_json: null, document_key: 'dk1', created_by: 'u1', created_at: now },
      ],
    });

    const result = await listVersions('f1');
    expect(result).toHaveLength(2);
    expect(result[0].versionNumber).toBe(2);
    expect(result[1].versionNumber).toBe(1);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY version_number DESC'),
      ['f1']
    );
  });

  it('returns empty array when no versions exist', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const result = await listVersions('f1');
    expect(result).toEqual([]);
  });
});

describe('getVersion', () => {
  it('returns the version record when found', async () => {
    const now = new Date().toISOString();
    mockQuery.mockResolvedValue({
      rows: [{ id: 'v1', file_id: 'f1', version_number: 3, s3_key: 'k3', size_bytes: 300, changes_s3_key: 'diff3', changes_json: null, document_key: 'dk3', created_by: 'u1', created_at: now }],
    });

    const result = await getVersion('f1', 3);
    expect(result).not.toBeNull();
    expect(result!.versionNumber).toBe(3);
  });

  it('returns null when version not found', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const result = await getVersion('f1', 99);
    expect(result).toBeNull();
  });
});
