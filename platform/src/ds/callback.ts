import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { Readable } from 'stream';
import { config } from '../config.js';
import * as storage from '../storage/s3.js';
import * as metadata from '../storage/metadata.js';
import * as versionRepo from '../versions/repository.js';
import { getAccountUsage, ACCOUNT_QUOTA_BYTES } from '../storage/quota.js';
import { markDocumentClosed } from './active-documents.js';
import { notifySaveComplete } from './save-events.js';
import path from 'path';

export const callbackRouter = Router();

// Maximum file size allowed for saves
const MAX_SAVE_SIZE_BYTES = 2 * 1024 * 1024;
// Warning threshold
const WARN_SIZE_BYTES = 1600 * 1024;

// In-memory store of recent save rejections/warnings (keyed by fileId)
interface SaveStatus {
  reason: 'size_limit_exceeded' | 'size_warning';
  size: number;
  limit: number;
  timestamp: number;
}
const saveRejections = new Map<string, SaveStatus>();

export interface CallbackPayload {
  status: number;
  url?: string;
  key?: string;
  changesurl?: string;
  history?: { changes: object[]; serverVersion: string };
  users?: string[];
  actions?: Array<{ type: number; userid: string }>;
}

async function archiveCurrentVersion(
  file: metadata.FileRecord,
  payload: CallbackPayload
): Promise<void> {
  // Determine which user triggered the save
  const userId = payload.actions?.[0]?.userid ?? file.userId;

  // Download current file content from storage
  const currentStream = await storage.download(file.s3Key);
  const chunks: Buffer[] = [];
  for await (const chunk of currentStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const currentContent = Buffer.concat(chunks);

  // Compute next version number
  const latestVersion = await versionRepo.getLatestVersionNumber(file.id);
  const nextVersion = latestVersion + 1;

  // Build versioned storage key
  const ext = path.extname(file.name);
  const versionS3Key = `${file.userId}/${file.id}/versions/${nextVersion}${ext}`;

  // Upload current content to versioned key
  await storage.upload(versionS3Key, currentContent, file.mimeType);

  // Document key for this version
  const documentKey = `${file.id}_${file.updatedAt.getTime()}`;

  // Handle diff/changes
  let changesS3Key: string | null = null;
  let changesJson: object | null = null;

  if (payload.changesurl) {
    try {
      const diffResponse = await fetch(payload.changesurl);
      if (diffResponse.ok && diffResponse.body) {
        const diffStream = Readable.fromWeb(diffResponse.body as any);
        const diffChunks: Buffer[] = [];
        for await (const chunk of diffStream) {
          diffChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const diffBuffer = Buffer.concat(diffChunks);
        const diffKey = `${file.userId}/${file.id}/versions/${nextVersion}.diff.zip`;
        await storage.upload(diffKey, diffBuffer, 'application/zip');
        changesS3Key = diffKey;
      }
    } catch (err) {
      console.error('Failed to download diff zip from changesurl', { fileId: file.id, err });
      changesS3Key = null;
    }
  }

  if (payload.history) {
    changesJson = payload.history;
  }

  // Insert version record
  await versionRepo.insertVersion({
    fileId: file.id,
    versionNumber: nextVersion,
    s3Key: versionS3Key,
    sizeBytes: currentContent.length,
    changesS3Key,
    changesJson,
    documentKey,
    createdBy: userId,
  });

  // Prune old versions beyond the cap
  try {
    const pruned = await versionRepo.pruneOldVersions(file.id);
    for (const entry of pruned) {
      await storage.remove(entry.s3Key);
      if (entry.changesS3Key) {
        await storage.remove(entry.changesS3Key);
      }
    }
  } catch (err) {
    console.error('Failed to prune old versions', { fileId: file.id, err });
  }
}

// POST /api/ds/callback?fileId=
// Authenticated via DS JWT in Authorization header
callbackRouter.post('/', async (req, res) => {
  try {
    // Verify JWT from DocumentServer
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : authHeader;

    try {
      jwt.verify(token, config.DS_JWT_SECRET);
    } catch {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { fileId } = req.query as { fileId: string };
    if (!fileId) {
      console.warn('Callback missing fileId query param');
      res.json({ error: 1 });
      return;
    }

    const payload = req.body as CallbackPayload;

    // Only process status 2 (document ready for saving) and status 6 (force save)
    if (payload.status !== 2 && payload.status !== 6) {
      // Status 4 = document closed with no changes — clear active tracking
      if (payload.status === 4) {
        markDocumentClosed(fileId).catch((err) =>
          console.error('[callback] Failed to mark document closed:', err)
        );
      }
      res.json({ error: 0 });
      return;
    }

    if (!payload.url) {
      console.warn('Callback status 2/6 but no URL provided', { fileId });
      res.json({ error: 1 });
      return;
    }

    const file = await metadata.getFile(fileId);
    if (!file) {
      console.error('Callback for non-existent file', { fileId });
      res.json({ error: 1 });
      return;
    }

    // Archive current version before overwrite
    try {
      await archiveCurrentVersion(file, payload);
    } catch (err) {
      console.error('Failed to archive version, continuing with save', { fileId, err });
    }

    // Download the updated document from DS-provided URL
    const response = await fetch(payload.url);
    if (!response.ok || !response.body) {
      console.error('Failed to download from DS URL', {
        fileId,
        url: payload.url,
        status: response.status,
      });
      res.json({ error: 1 });
      return;
    }

    // Convert web ReadableStream to Node Readable
    const nodeStream = Readable.fromWeb(response.body as any);

    // Buffer the content to get size
    const chunks: Buffer[] = [];
    for await (const chunk of nodeStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);

    // Reject save if file exceeds size limit
    if (buffer.length > MAX_SAVE_SIZE_BYTES) {
      console.warn('Save rejected: file exceeds size limit', {
        fileId,
        size: buffer.length,
        limit: MAX_SAVE_SIZE_BYTES,
      });
      // Store rejection reason so client can query it
      saveRejections.set(fileId, {
        reason: 'size_limit_exceeded',
        size: buffer.length,
        limit: MAX_SAVE_SIZE_BYTES,
        timestamp: Date.now(),
      });
      res.json({ error: 1 });
      return;
    }

    // Reject save if account quota is exceeded
    const quota = await getAccountUsage(file.userId);
    const newTotal = quota.usedBytes - file.sizeBytes + buffer.length;
    if (newTotal > ACCOUNT_QUOTA_BYTES) {
      console.warn('Save rejected: account quota exceeded', {
        fileId,
        userId: file.userId,
        currentUsage: quota.usedBytes,
        newFileSize: buffer.length,
        limit: ACCOUNT_QUOTA_BYTES,
      });
      saveRejections.set(fileId, {
        reason: 'size_limit_exceeded',
        size: newTotal,
        limit: ACCOUNT_QUOTA_BYTES,
        timestamp: Date.now(),
      });
      res.json({ error: 1 });
      return;
    }

    // Track warning state if approaching limit
    if (buffer.length > WARN_SIZE_BYTES) {
      saveRejections.set(fileId, {
        reason: 'size_warning',
        size: buffer.length,
        limit: MAX_SAVE_SIZE_BYTES,
        timestamp: Date.now(),
      });
    } else {
      // Clear any previous warning
      saveRejections.delete(fileId);
    }

    // Upload to storage, replacing previous version
    await storage.upload(file.s3Key, buffer, file.mimeType);

    // Update metadata
    await metadata.updateFile(file.id, { sizeBytes: buffer.length });

    // Notify any waiting export routes that this file is persisted
    notifySaveComplete(fileId);

    // Status 2 = closed after saving — clear active tracking
    if (payload.status === 2) {
      markDocumentClosed(fileId).catch((err) =>
        console.error('[callback] Failed to mark document closed:', err)
      );
    }

    res.json({ error: 0 });
  } catch (err) {
    console.error('Callback handler error:', err);
    res.json({ error: 1 });
  }
});

// GET /api/ds/callback/save-status?fileId=
// Client polls this after onError to check if the save was rejected due to size
callbackRouter.get('/save-status', (req, res) => {
  const { fileId } = req.query as { fileId: string };
  if (!fileId) {
    res.json({ status: 'ok' });
    return;
  }

  const entry = saveRejections.get(fileId);
  if (!entry) {
    res.json({ status: 'ok' });
    return;
  }

  // Only return entries from the last 60 seconds
  if (Date.now() - entry.timestamp > 60_000) {
    saveRejections.delete(fileId);
    res.json({ status: 'ok' });
    return;
  }

  res.json({
    status: entry.reason,
    size: entry.size,
    limit: entry.limit,
  });
});
