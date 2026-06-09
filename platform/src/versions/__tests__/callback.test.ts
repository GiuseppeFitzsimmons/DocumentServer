import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';

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

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { callbackRouter } from '../../ds/callback.js';
import express from 'express';
import http from 'http';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/callback', callbackRouter);
  return app;
}

function postCallback(app: express.Express, fileId: string, body: object, authHeader?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = (server.address() as any).port;
      const data = JSON.stringify(body);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(data)),
      };
      if (authHeader !== undefined && authHeader !== '') {
        headers['Authorization'] = authHeader;
      }

      const req = http.request({
        hostname: 'localhost',
        port,
        path: `/callback?fileId=${fileId}`,
        method: 'POST',
        headers,
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
  mockGetLatestVersionNumber.mockResolvedValue(0);
  mockInsertVersion.mockResolvedValue({ id: 'ver-1' });
});

describe('Callback Handler - Version Archival', () => {
  const file = {
    id: 'file-1',
    name: 'doc.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sizeBytes: 1000,
    userId: 'user-1',
    folderId: null,
    s3Key: 'user-1/file-1/doc.docx',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  };

  it('archives current version before overwriting on status 2', async () => {
    mockGetFile.mockResolvedValue(file);
    const existingContent = Buffer.from('old content');
    mockDownload.mockResolvedValue(Readable.from([existingContent]));

    const newContent = Buffer.from('new content');
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
    const result = await postCallback(app, 'file-1', {
      status: 2,
      url: 'http://ds/file.docx',
      actions: [{ type: 1, userid: 'user-1' }],
    }, 'Bearer valid');

    expect(result.body.error).toBe(0);
    expect(mockUpload).toHaveBeenCalledWith(
      'user-1/file-1/versions/1.docx',
      existingContent,
      file.mimeType
    );
    expect(mockInsertVersion).toHaveBeenCalledWith(expect.objectContaining({
      fileId: 'file-1',
      versionNumber: 1,
      s3Key: 'user-1/file-1/versions/1.docx',
      sizeBytes: existingContent.length,
    }));
  });

  it('handles status 6 (force save) with archival', async () => {
    mockGetFile.mockResolvedValue(file);
    mockDownload.mockResolvedValue(Readable.from([Buffer.from('current')]));
    mockFetch.mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('force-saved'));
          controller.close();
        },
      }),
    });

    const app = createApp();
    const result = await postCallback(app, 'file-1', {
      status: 6,
      url: 'http://ds/file.docx',
      actions: [{ type: 1, userid: 'user-1' }],
    }, 'Bearer valid');

    expect(result.body.error).toBe(0);
    expect(mockInsertVersion).toHaveBeenCalled();
  });

  it('continues save if archival fails', async () => {
    mockGetFile.mockResolvedValue(file);
    mockDownload.mockRejectedValue(new Error('storage read error'));
    mockFetch.mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('new'));
          controller.close();
        },
      }),
    });

    const app = createApp();
    const result = await postCallback(app, 'file-1', {
      status: 2,
      url: 'http://ds/file.docx',
    }, 'Bearer valid');

    expect(result.body.error).toBe(0);
    expect(mockUpload).toHaveBeenCalledWith(file.s3Key, expect.any(Buffer), file.mimeType);
  });

  it('stores diff zip when changesurl is present', async () => {
    mockGetFile.mockResolvedValue(file);
    mockDownload.mockResolvedValue(Readable.from([Buffer.from('old')]));

    const diffContent = Buffer.from('diff-zip-data');
    const newContent = Buffer.from('new content');

    mockFetch.mockImplementation((url: string) => {
      if (url === 'http://ds/changes.zip') {
        return Promise.resolve({
          ok: true,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(diffContent);
              controller.close();
            },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(newContent);
            controller.close();
          },
        }),
      });
    });

    const app = createApp();
    const result = await postCallback(app, 'file-1', {
      status: 2,
      url: 'http://ds/file.docx',
      changesurl: 'http://ds/changes.zip',
      history: { changes: [{ test: true }], serverVersion: '7.0' },
      actions: [{ type: 1, userid: 'user-1' }],
    }, 'Bearer valid');

    expect(result.body.error).toBe(0);
    expect(mockUpload).toHaveBeenCalledWith(
      'user-1/file-1/versions/1/diff.zip',
      diffContent,
      'application/zip'
    );
    expect(mockInsertVersion).toHaveBeenCalledWith(expect.objectContaining({
      changesS3Key: 'user-1/file-1/versions/1/diff.zip',
      changesJson: { changes: [{ test: true }], serverVersion: '7.0' },
    }));
  });

  it('ignores non-2/6 status callbacks', async () => {
    const app = createApp();
    const result = await postCallback(app, 'file-1', { status: 4 }, 'Bearer valid');

    expect(result.body.error).toBe(0);
    expect(mockGetFile).not.toHaveBeenCalled();
  });
});
