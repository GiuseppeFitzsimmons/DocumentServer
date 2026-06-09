import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    req.session = { userId: 'user-1' };
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

vi.mock('../../session.js', () => ({
  sessionMiddleware: (req: any, _res: any, next: any) => {
    req.session = req.session || { userId: 'user-1' };
    next();
  },
}));

import { versionRouter } from '../routes.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.session = { userId: 'user-1' };
    next();
  });
  app.use('/api/files', versionRouter);
  return app;
}

function makeRequest(app: express.Express, method: string, path: string): Promise<{ status: number; body: any; rawBody: string }> {
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
            resolve({ status: res.statusCode!, body: JSON.parse(data), rawBody: data });
          } catch {
            resolve({ status: res.statusCode!, body: null, rawBody: data });
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

const file = {
  id: 'file-1',
  name: 'doc.docx',
  mimeType: 'application/octet-stream',
  sizeBytes: 1000,
  userId: 'user-1',
  folderId: null,
  s3Key: 'user-1/file-1/doc.docx',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

describe('GET /api/files/:fileId/versions', () => {
  it('returns version list for file owner', async () => {
    mockGetFile.mockResolvedValue(file);
    mockGetShare.mockResolvedValue(null);
    mockListVersions.mockResolvedValue([
      { versionNumber: 2, documentKey: 'dk2', createdAt: new Date('2024-01-03'), createdBy: 'user-1', changesJson: null, sizeBytes: 200 },
      { versionNumber: 1, documentKey: 'dk1', createdAt: new Date('2024-01-02'), createdBy: 'user-1', changesJson: null, sizeBytes: 100 },
    ]);
    mockPoolQuery.mockResolvedValue({ rows: [{ id: 'user-1', display_name: 'John' }] });

    const app = createApp();
    const result = await makeRequest(app, 'GET', '/api/files/file-1/versions');

    expect(result.status).toBe(200);
    expect(result.body.history).toHaveLength(2);
    expect(result.body.history[0].version).toBe(2);
    expect(result.body.currentVersion).toBe(3);
  });

  it('returns 403 for unauthorized user', async () => {
    mockGetFile.mockResolvedValue({ ...file, userId: 'other-user' });
    mockGetShare.mockResolvedValue(null);

    const app = createApp();
    const result = await makeRequest(app, 'GET', '/api/files/file-1/versions');

    expect(result.status).toBe(403);
  });
});

describe('GET /api/files/:fileId/versions/:ver/content', () => {
  it('streams version content with valid JWT', async () => {
    mockGetVersion.mockResolvedValue({ s3Key: 'user-1/file-1/versions/1.docx' });
    mockDownload.mockResolvedValue(Readable.from([Buffer.from('version content')]));

    const app = createApp();
    const result = await makeRequest(app, 'GET', '/api/files/file-1/versions/1/content?token=valid');

    expect(result.status).toBe(200);
    expect(result.rawBody).toBe('version content');
  });

  it('returns 401 without token', async () => {
    const app = createApp();
    const result = await makeRequest(app, 'GET', '/api/files/file-1/versions/1/content');

    expect(result.status).toBe(401);
  });

  it('returns 404 for non-existent version', async () => {
    mockGetVersion.mockResolvedValue(null);

    const app = createApp();
    const result = await makeRequest(app, 'GET', '/api/files/file-1/versions/99/content?token=valid');

    expect(result.status).toBe(404);
  });
});

describe('POST /api/files/:fileId/versions/:ver/restore', () => {
  it('restores a version for file owner', async () => {
    mockGetFile.mockResolvedValue(file);
    mockGetShare.mockResolvedValue(null);
    mockGetVersion.mockResolvedValue({ s3Key: 'user-1/file-1/versions/1.docx', versionNumber: 1 });
    mockGetLatestVersionNumber.mockResolvedValue(1);
    mockDownload
      .mockResolvedValueOnce(Readable.from([Buffer.from('current content')]))
      .mockResolvedValueOnce(Readable.from([Buffer.from('old content')]));

    const app = createApp();
    const result = await makeRequest(app, 'POST', '/api/files/file-1/versions/1/restore');

    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);
    expect(mockInsertVersion).toHaveBeenCalled();
    expect(mockUpload).toHaveBeenCalledTimes(2);
  });

  it('returns 403 for shared user without edit permission', async () => {
    mockGetFile.mockResolvedValue({ ...file, userId: 'other-user' });
    mockGetShare.mockResolvedValue({ permissions: { edit: false } });

    const app = createApp();
    const result = await makeRequest(app, 'POST', '/api/files/file-1/versions/1/restore');

    expect(result.status).toBe(403);
  });
});
