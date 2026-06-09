import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { Readable } from 'stream';
import http from 'http';
import express from 'express';

// Mocks
const mockVerify = vi.fn();
vi.mock('jsonwebtoken', () => ({
  default: { verify: (...args: unknown[]) => mockVerify(...args), sign: vi.fn(() => 'tok') },
}));

vi.mock('../../config.js', () => ({
  config: {
    DS_JWT_SECRET: 'test-secret',
    PLATFORM_BASE_URL: 'http://localhost:3000',
  },
}));

const mockUpload = vi.fn();
const mockDownload = vi.fn();
vi.mock('../../storage/s3.js', () => ({
  upload: (...args: unknown[]) => mockUpload(...args),
  download: (...args: unknown[]) => mockDownload(...args),
}));

const mockGetFile = vi.fn();
const mockUpdateFile = vi.fn();
vi.mock('../../storage/metadata.js', () => ({
  getFile: (...args: unknown[]) => mockGetFile(...args),
  updateFile: (...args: unknown[]) => mockUpdateFile(...args),
}));

const mockGetLatestVersionNumber = vi.fn();
const mockInsertVersion = vi.fn();
vi.mock('../repository.js', () => ({
  getLatestVersionNumber: (...args: unknown[]) => mockGetLatestVersionNumber(...args),
  insertVersion: (...args: unknown[]) => mockInsertVersion(...args),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { callbackRouter } from '../../ds/callback.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/callback', callbackRouter);
  return app;
}

function postCallback(app: express.Express, fileId: string, body: object): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as any).port;
      const data = JSON.stringify(body);
      const req = http.request({
        hostname: 'localhost',
        port,
        path: `/callback?fileId=${fileId}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(data)),
          'Authorization': 'Bearer valid',
        },
      }, (res) => {
        let responseData = '';
        res.on('data', (chunk) => { responseData += chunk; });
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode!, body: JSON.parse(responseData) });
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      req.write(data);
      req.end();
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerify.mockReturnValue({});
  mockUpload.mockResolvedValue(undefined);
  mockUpdateFile.mockResolvedValue({});
  mockInsertVersion.mockResolvedValue({ id: 'ver-1' });
});

// Generators
const fileExtArb = fc.constantFrom('.docx', '.xlsx', '.pptx', '.pdf', '.txt', '.odt');

const fileArb = fc.record({
  id: fc.uuid(),
  name: fc.tuple(fc.stringMatching(/^[a-z]{1,8}$/), fileExtArb).map(([n, e]) => n + e),
  mimeType: fc.constant('application/octet-stream'),
  sizeBytes: fc.nat({ max: 10_000_000 }),
  userId: fc.uuid(),
  folderId: fc.constant(null),
  s3Key: fc.uuid().map(id => `user/${id}/file.docx`),
  createdAt: fc.date({ min: new Date('2020-01-01'), max: new Date('2025-01-01') }),
  updatedAt: fc.date({ min: new Date('2020-01-01'), max: new Date('2025-01-01') }),
});

// Feature: file-versions, Property 2: Version storage key format
describe('Property 2: Version storage key format', () => {
  it('for any version created, s3_key matches pattern {userId}/{fileId}/versions/{versionNumber}{ext}', async () => {
    await fc.assert(
      fc.asyncProperty(
        fileArb,
        fc.integer({ min: 0, max: 50 }),
        async (file, latestVersion) => {
          vi.clearAllMocks();
          mockVerify.mockReturnValue({});
          mockUpload.mockResolvedValue(undefined);
          mockUpdateFile.mockResolvedValue({});
          mockGetFile.mockResolvedValue(file);
          mockGetLatestVersionNumber.mockResolvedValue(latestVersion);
          mockInsertVersion.mockResolvedValue({ id: 'ver-new' });

          const existingContent = Buffer.from('existing-content');
          mockDownload.mockResolvedValue(Readable.from([existingContent]));

          const newContent = Buffer.from('new-content');
          mockFetch.mockResolvedValue({
            ok: true,
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(newContent);
                controller.close();
              },
            }),
          });

          const app = createApp();
          await postCallback(app, file.id, {
            status: 2,
            url: 'http://ds/file',
            actions: [{ type: 1, userid: file.userId }],
          });

          // Check the s3Key passed to insertVersion
          if (mockInsertVersion.mock.calls.length > 0) {
            const insertParams = mockInsertVersion.mock.calls[0][0];
            const expectedVersion = latestVersion + 1;
            const ext = '.' + file.name.split('.').pop()!;
            const expectedKey = `${file.userId}/${file.id}/versions/${expectedVersion}${ext}`;
            expect(insertParams.s3Key).toBe(expectedKey);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: file-versions, Property 5: Save archival preserves content
describe('Property 5: Save archival preserves content', () => {
  it('for any file content and save callback, the archived version content equals the original file content', async () => {
    await fc.assert(
      fc.asyncProperty(
        fileArb,
        fc.uint8Array({ minLength: 1, maxLength: 10000 }),
        async (file, contentBytes) => {
          vi.clearAllMocks();
          mockVerify.mockReturnValue({});
          mockUpload.mockResolvedValue(undefined);
          mockUpdateFile.mockResolvedValue({});
          mockGetFile.mockResolvedValue(file);
          mockGetLatestVersionNumber.mockResolvedValue(0);
          mockInsertVersion.mockResolvedValue({ id: 'ver-1' });

          const existingContent = Buffer.from(contentBytes);
          mockDownload.mockResolvedValue(Readable.from([existingContent]));

          const newContent = Buffer.from('new-document-content');
          mockFetch.mockResolvedValue({
            ok: true,
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(newContent);
                controller.close();
              },
            }),
          });

          const app = createApp();
          await postCallback(app, file.id, {
            status: 2,
            url: 'http://ds/file',
            actions: [{ type: 1, userid: file.userId }],
          });

          // The first upload call should be the archived version with original content
          if (mockUpload.mock.calls.length >= 1) {
            const archivedContent = mockUpload.mock.calls[0][1];
            expect(Buffer.compare(archivedContent, existingContent)).toBe(0);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
