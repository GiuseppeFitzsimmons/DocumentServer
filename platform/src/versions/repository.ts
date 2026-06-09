import { pool } from '../db/pool.js';

export const MAX_VERSIONS_PER_FILE = 50;

export interface FileVersionRecord {
  id: string;
  fileId: string;
  versionNumber: number;
  s3Key: string;
  sizeBytes: number;
  changesS3Key: string | null;
  changesJson: object | null;
  documentKey: string;
  createdBy: string;
  createdAt: Date;
}

export interface InsertVersionParams {
  fileId: string;
  versionNumber: number;
  s3Key: string;
  sizeBytes: number;
  changesS3Key?: string | null;
  changesJson?: object | null;
  documentKey: string;
  createdBy: string;
}

export async function getLatestVersionNumber(fileId: string): Promise<number> {
  const { rows } = await pool.query(
    'SELECT COALESCE(MAX(version_number), 0) AS max_version FROM file_versions WHERE file_id = $1',
    [fileId]
  );
  return Number(rows[0].max_version);
}

export async function insertVersion(params: InsertVersionParams): Promise<FileVersionRecord> {
  const { rows } = await pool.query(
    `INSERT INTO file_versions (file_id, version_number, s3_key, size_bytes, changes_s3_key, changes_json, document_key, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      params.fileId,
      params.versionNumber,
      params.s3Key,
      params.sizeBytes,
      params.changesS3Key ?? null,
      params.changesJson ? JSON.stringify(params.changesJson) : null,
      params.documentKey,
      params.createdBy,
    ]
  );
  return mapRow(rows[0]);
}

export async function listVersions(fileId: string): Promise<FileVersionRecord[]> {
  const { rows } = await pool.query(
    'SELECT * FROM file_versions WHERE file_id = $1 ORDER BY version_number DESC',
    [fileId]
  );
  return rows.map(mapRow);
}

export async function getVersion(fileId: string, versionNumber: number): Promise<FileVersionRecord | null> {
  const { rows } = await pool.query(
    'SELECT * FROM file_versions WHERE file_id = $1 AND version_number = $2',
    [fileId, versionNumber]
  );
  return rows.length ? mapRow(rows[0]) : null;
}

function mapRow(row: Record<string, unknown>): FileVersionRecord {
  return {
    id: row.id as string,
    fileId: row.file_id as string,
    versionNumber: Number(row.version_number),
    s3Key: row.s3_key as string,
    sizeBytes: Number(row.size_bytes),
    changesS3Key: (row.changes_s3_key as string) || null,
    changesJson: row.changes_json as object | null,
    documentKey: row.document_key as string,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
  };
}

/**
 * Deletes the oldest versions beyond the cap, returning their storage keys
 * so the caller can clean up the files from storage.
 */
export async function pruneOldVersions(fileId: string, maxVersions: number = MAX_VERSIONS_PER_FILE): Promise<{ s3Key: string; changesS3Key: string | null }[]> {
  const { rows } = await pool.query(
    `DELETE FROM file_versions
     WHERE id IN (
       SELECT id FROM file_versions
       WHERE file_id = $1
       ORDER BY version_number ASC
       LIMIT GREATEST((SELECT COUNT(*) FROM file_versions WHERE file_id = $1) - $2, 0)
     )
     RETURNING s3_key, changes_s3_key`,
    [fileId, maxVersions]
  );
  return rows.map((row: Record<string, unknown>) => ({
    s3Key: row.s3_key as string,
    changesS3Key: (row.changes_s3_key as string) || null,
  }));
}
