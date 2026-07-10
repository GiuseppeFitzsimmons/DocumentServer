/**
 * Tracks which documents currently have active editing sessions.
 *
 * Uses Redis to maintain a set of active document keys. The platform records
 * when a document is opened (editor page load) and removes it when the DS
 * callback reports the document was closed (status 4) or saved-and-closed (status 2).
 *
 * For blue-green deploy forcesave, this gives us a reliable list of documents
 * that need to be force-saved before killing the server — independent of DS's
 * unreliable `info` command.
 */

import Redis from 'ioredis';
import { config } from '../config.js';
import { pool } from '../db/pool.js';

const ACTIVE_DOCS_KEY = 'active_documents';

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(config.REDIS_URL);
  }
  return redis;
}

/**
 * Record that a document is being actively edited.
 * Call this when the editor page is loaded.
 */
export async function markDocumentOpen(fileId: string, documentKey: string): Promise<void> {
  const r = getRedis();
  // Store as hash: fileId -> documentKey
  await r.hset(ACTIVE_DOCS_KEY, fileId, documentKey);
}

/**
 * Record that a document is no longer being actively edited.
 * Call this from the DS callback when status indicates closure (status 2 or 4).
 */
export async function markDocumentClosed(fileId: string): Promise<void> {
  const r = getRedis();
  await r.hdel(ACTIVE_DOCS_KEY, fileId);
}

/**
 * Get all currently active document keys from Redis tracking.
 * Returns an array of { fileId, documentKey } objects.
 */
export async function getActiveDocuments(): Promise<Array<{ fileId: string; documentKey: string }>> {
  const r = getRedis();
  const all = await r.hgetall(ACTIVE_DOCS_KEY);
  return Object.entries(all).map(([fileId, documentKey]) => ({ fileId, documentKey }));
}

/**
 * Fallback: get all possible document keys from the database.
 * This constructs keys using the same formula as editorConfig:
 *   `${file.id}_${file.updatedAt.getTime()}`
 *
 * Used as a safety net when Redis tracking might have gaps (e.g. after a
 * platform restart where Redis wasn't persisted).
 */
export async function getAllDocumentKeysFromDB(): Promise<Array<{ fileId: string; documentKey: string }>> {
  const { rows } = await pool.query(
    `SELECT id, updated_at FROM files`
  );
  return rows.map((row: any) => ({
    fileId: row.id as string,
    documentKey: `${row.id}_${new Date(row.updated_at).getTime()}`,
  }));
}

/**
 * Get the comprehensive list of document keys to forcesave.
 * Merges Redis-tracked active docs with the DB fallback, deduplicating by fileId.
 * The Redis-tracked keys take priority (they reflect the current editing session's key).
 */
export async function getDocumentsToForceSave(
  strategy: 'tracked' | 'all' | 'both' = 'both'
): Promise<Array<{ fileId: string; documentKey: string }>> {
  if (strategy === 'tracked') {
    return getActiveDocuments();
  }

  if (strategy === 'all') {
    return getAllDocumentKeysFromDB();
  }

  // 'both' — merge with Redis taking priority
  const tracked = await getActiveDocuments();
  const fromDb = await getAllDocumentKeysFromDB();

  const merged = new Map<string, string>();

  // DB keys as baseline
  for (const { fileId, documentKey } of fromDb) {
    merged.set(fileId, documentKey);
  }

  // Redis-tracked keys override (they have the current session key)
  for (const { fileId, documentKey } of tracked) {
    merged.set(fileId, documentKey);
  }

  return Array.from(merged.entries()).map(([fileId, documentKey]) => ({
    fileId,
    documentKey,
  }));
}
