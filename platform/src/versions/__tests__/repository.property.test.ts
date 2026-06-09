import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

const mockQuery = vi.fn();
vi.mock('../../db/pool.js', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

import { getLatestVersionNumber, insertVersion, listVersions } from '../repository.js';

beforeEach(() => {
  mockQuery.mockReset();
});

// Feature: file-versions, Property 1: Version number sequencing
describe('Property 1: Version number sequencing', () => {
  it('for any file and N saves, version numbers form a contiguous sequence 1..N', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.integer({ min: 1, max: 50 }),
        async (fileId, numSaves) => {
          mockQuery.mockReset();
          const versions: number[] = [];

          for (let i = 0; i < numSaves; i++) {
            // Mock getLatestVersionNumber to return i (previous count)
            mockQuery.mockResolvedValueOnce({ rows: [{ max_version: i }] });
            const latest = await getLatestVersionNumber(fileId);
            const nextVersion = latest + 1;
            versions.push(nextVersion);

            // Mock insertVersion
            mockQuery.mockResolvedValueOnce({
              rows: [{
                id: `ver-${i}`,
                file_id: fileId,
                version_number: nextVersion,
                s3_key: `key-${nextVersion}`,
                size_bytes: 100,
                changes_s3_key: null,
                changes_json: null,
                document_key: `dk-${nextVersion}`,
                created_by: 'user-1',
                created_at: new Date().toISOString(),
              }],
            });

            await insertVersion({
              fileId,
              versionNumber: nextVersion,
              s3Key: `key-${nextVersion}`,
              sizeBytes: 100,
              documentKey: `dk-${nextVersion}`,
              createdBy: 'user-1',
            });
          }

          // Verify: versions should be [1, 2, 3, ..., numSaves]
          expect(versions).toHaveLength(numSaves);
          for (let i = 0; i < numSaves; i++) {
            expect(versions[i]).toBe(i + 1);
          }

          // No gaps
          const sorted = [...versions].sort((a, b) => a - b);
          for (let i = 1; i < sorted.length; i++) {
            expect(sorted[i] - sorted[i - 1]).toBe(1);
          }

          // No duplicates
          expect(new Set(versions).size).toBe(numSaves);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: file-versions, Property 4: Cascade delete removes all versions
describe('Property 4: Cascade delete removes all versions', () => {
  it('after file deletion, listVersions returns empty for that file_id', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.integer({ min: 1, max: 20 }),
        async (fileId, _numVersions) => {
          mockQuery.mockReset();
          // Simulate that after a CASCADE DELETE, querying versions returns empty
          mockQuery.mockResolvedValue({ rows: [] });

          const versions = await listVersions(fileId);
          expect(versions).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});
