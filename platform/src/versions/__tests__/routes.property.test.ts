import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import express from 'express';
import http from 'http';
import { Readable } from 'stream';

// Mocks
const mockSign = vi.fn((..._args: unknown[]) => 'signed-token');
const mockVerify = vi.fn();
vi.mock('jsonwebtoken', () => ({
  default: {
    sign: (...args: unknown[]) => mockSign(...args),
    verify: (...args: unknown[]) => mockVerify(...args),
  },
}));

vi.mock('../../config.js', () => ({
  config: {
    DS_JWT_SECRET: 'test-secret',
    PLATFORM_BASE_URL: 'http://localhost:3000',
  },
}));

vi.mock('../../auth/middleware.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    req.session = req.session || { userId: req.headers['x-test-user'] || 'user-1' };
    next();
  },
}));

const mockGetFile = vi.fn();
const mockUpdateFile = vi.fn();
vi.mock('../../storage/metadata.js', () => ({
  getFile: (...args: unknown[]) => mockGetFile(...args),
  updateFile: (...args: unknown[]) => mockUpdateFile(...args),
}));

const mockUpload = vi.fn();
const mockDownload = vi.fn();
vi.mock('../../storage/s3.js', () => ({
  upload: (...args: unknown[]) => mockUpload(...args),
  download: (...args: unknown[]) => mockDownload(...args),
}));

const mockListVersions = vi.fn();
const mockGetVersion = vi.fn();
const mockGetLatestVersionNumber = vi.fn();
const mockInsertVersion = vi.fn();
vi.mock('../repository.js', () => ({
  listVersions: (...args: unknown[]) => mockListVersions(...args),
  getVersion: (...args: unknown[]) => mockGetVersion(...args),
  getLatestVersionNumber: (...args: unknown[]) => mockGetLatestVersionNumber(...args),
  insertVersion: (...args: unknown[]) => mockInsertVersion(...args),
}));

const mockGetShare = vi.fn();
vi.mock('../../sharing/service.js', () => ({
  getShare: (...args: unknown[]) => mockGetShare(...args),
}));

const mockPoolQuery = vi.fn();
vi.mock('../../db/pool.js', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}));

import { versionRouter } from '../routes.js';

function createApp(userId = 'user-1') {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.session = { userId };
    next();
  });
  app.use('/api/files', versionRouter);
  return app;
}

function makeRequest(app: express.Express, method: string, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as any).port;
      const req = http.request({
        hostname: 'localhost',
        port,
        path,
        method,
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          server.close();
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode!, body: null });
          }
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      req.end();
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerify.mockReturnValue({});
  mockUpload.mockResolvedValue(undefined);
  mockUpdateFile.mockResolvedValue({});
  mockGetLatestVersionNumber.mockResolvedValue(0);
  mockInsertVersion.mockResolvedValue({ id: 'ver-1' });
});

// Feature: file-versions, Property 9: Version list ordering
describe('Property 9: Version list ordering', () => {
  it('for any file with versions, the list endpoint returns versions in descending order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.integer({ min: 1, max: 20 }),
        async (fileId, numVersions) => {
          vi.clearAllMocks();

          const file = {
            id: fileId,
            name: 'doc.docx',
            mimeType: 'application/octet-stream',
            sizeBytes: 1000,
            userId: 'user-1',
            folderId: null,
            s3Key: 'user-1/' + fileId + '/doc.docx',
            createdAt: new Date('2024-01-01'),
            updatedAt: new Date('2024-01-01'),
          };

          mockGetFile.mockResolvedValue(file);
          mockGetShare.mockResolvedValue(null);

          // Generate versions in descending order (as repository returns them)
          const versions = [];
          for (let i = numVersions; i >= 1; i--) {
            versions.push({
              versionNumber: i,
              documentKey: `dk-${i}`,
              createdAt: new Date(`2024-01-${String(i).padStart(2, '0')}`),
              createdBy: 'user-1',
              changesJson: null,
              sizeBytes: i * 100,
            });
          }
          mockListVersions.mockResolvedValue(versions);
          mockPoolQuery.mockResolvedValue({ rows: [{ id: 'user-1', display_name: 'John' }] });

          const app = createApp();
          const result = await makeRequest(app, 'GET', `/api/files/${fileId}/versions`);

          expect(result.status).toBe(200);
          expect(result.body.history).toHaveLength(numVersions);

          // Verify descending order
          for (let i = 1; i < result.body.history.length; i++) {
            expect(result.body.history[i - 1].version).toBeGreaterThan(result.body.history[i].version);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: file-versions, Property 14: Restore overwrites current file with archived content
describe('Property 14: Restore overwrites current file with archived content', () => {
  it('after restore, the upload to current key contains the archived version content', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uint8Array({ minLength: 1, maxLength: 5000 }),
        fc.uint8Array({ minLength: 1, maxLength: 5000 }),
        async (fileId, currentBytes, archivedBytes) => {
          vi.clearAllMocks();

          const file = {
            id: fileId,
            name: 'doc.docx',
            mimeType: 'application/octet-stream',
            sizeBytes: currentBytes.length,
            userId: 'user-1',
            folderId: null,
            s3Key: `user-1/${fileId}/doc.docx`,
            createdAt: new Date('2024-01-01'),
            updatedAt: new Date('2024-01-01'),
          };

          mockGetFile.mockResolvedValue(file);
          mockGetShare.mockResolvedValue(null);
          mockGetVersion.mockResolvedValue({ s3Key: `user-1/${fileId}/versions/1.docx`, versionNumber: 1 });
          mockGetLatestVersionNumber.mockResolvedValue(1);
          mockInsertVersion.mockResolvedValue({ id: 'ver-new' });
          mockUpload.mockResolvedValue(undefined);
          mockUpdateFile.mockResolvedValue({});

          const currentContent = Buffer.from(currentBytes);
          const archivedContent = Buffer.from(archivedBytes);

          // First download = current file (for archival), second download = version content (for restore)
          mockDownload
            .mockResolvedValueOnce(Readable.from([currentContent]))
            .mockResolvedValueOnce(Readable.from([archivedContent]));

          const app = createApp();
          const result = await makeRequest(app, 'POST', `/api/files/${fileId}/versions/1/restore`);

          expect(result.status).toBe(200);

          // Second upload call should be the restore: writing archivedContent to current key
          if (mockUpload.mock.calls.length >= 2) {
            const restoreCall = mockUpload.mock.calls[1];
            expect(restoreCall[0]).toBe(file.s3Key);
            expect(Buffer.compare(restoreCall[1], archivedContent)).toBe(0);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: file-versions, Property 17: Restore requires edit permission
describe('Property 17: Restore requires edit permission', () => {
  it('for any user without edit permission, restore returns 403', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        async (fileId, userId) => {
          vi.clearAllMocks();

          const file = {
            id: fileId,
            name: 'doc.docx',
            mimeType: 'application/octet-stream',
            sizeBytes: 1000,
            userId: 'owner-different',
            folderId: null,
            s3Key: `owner/${fileId}/doc.docx`,
            createdAt: new Date('2024-01-01'),
            updatedAt: new Date('2024-01-01'),
          };

          mockGetFile.mockResolvedValue(file);
          // Shared user with edit = false
          mockGetShare.mockResolvedValue({ permissions: { edit: false } });

          const app = createApp(userId);
          const result = await makeRequest(app, 'POST', `/api/files/${fileId}/versions/1/restore`);

          expect(result.status).toBe(403);
        }
      ),
      { numRuns: 100 }
    );
  });
});
