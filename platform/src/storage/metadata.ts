import { pool } from '../db/pool.js';

export interface FileRecord {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  userId: string;
  folderId: string | null;
  s3Key: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface FolderRecord {
  id: string;
  name: string;
  userId: string;
  parentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// --- File operations ---

export async function createFile(params: {
  name: string;
  mimeType: string;
  sizeBytes: number;
  userId: string;
  folderId: string | null;
  s3Key: string;
}): Promise<FileRecord> {
  const { rows } = await pool.query(
    `INSERT INTO files (name, mime_type, size_bytes, user_id, folder_id, s3_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [params.name, params.mimeType, params.sizeBytes, params.userId, params.folderId, params.s3Key]
  );
  return mapFileRow(rows[0]);
}

export async function getFile(id: string): Promise<FileRecord | null> {
  const { rows } = await pool.query('SELECT * FROM files WHERE id = $1', [id]);
  return rows.length ? mapFileRow(rows[0]) : null;
}

export async function updateFile(
  id: string,
  updates: Partial<Pick<FileRecord, 'name' | 'folderId' | 'sizeBytes'>>
): Promise<FileRecord> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (updates.name !== undefined) {
    setClauses.push(`name = $${idx++}`);
    values.push(updates.name);
  }
  if (updates.folderId !== undefined) {
    setClauses.push(`folder_id = $${idx++}`);
    values.push(updates.folderId);
  }
  if (updates.sizeBytes !== undefined) {
    setClauses.push(`size_bytes = $${idx++}`);
    values.push(updates.sizeBytes);
  }

  setClauses.push(`updated_at = NOW()`);
  values.push(id);

  const { rows } = await pool.query(
    `UPDATE files SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return mapFileRow(rows[0]);
}

export async function deleteFile(id: string): Promise<void> {
  await pool.query('DELETE FROM files WHERE id = $1', [id]);
}

export async function listFolder(
  userId: string,
  folderId: string | null
): Promise<{ files: FileRecord[]; folders: FolderRecord[] }> {
  const fileQuery = folderId
    ? pool.query('SELECT * FROM files WHERE user_id = $1 AND folder_id = $2', [userId, folderId])
    : pool.query('SELECT * FROM files WHERE user_id = $1 AND folder_id IS NULL', [userId]);

  const folderQuery = folderId
    ? pool.query('SELECT * FROM folders WHERE user_id = $1 AND parent_id = $2', [userId, folderId])
    : pool.query('SELECT * FROM folders WHERE user_id = $1 AND parent_id IS NULL', [userId]);

  const [fileResult, folderResult] = await Promise.all([fileQuery, folderQuery]);

  return {
    files: fileResult.rows.map(mapFileRow),
    folders: folderResult.rows.map(mapFolderRow),
  };
}
export async function getRecentFiles(userId: string, limit: number): Promise<FileRecord[]> {
  const { rows } = await pool.query(
    'SELECT * FROM files WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2',
    [userId, limit]
  );
  return rows.map(mapFileRow);
}

// --- Folder operations ---

export async function createFolder(params: {
  name: string;
  userId: string;
  parentId: string | null;
}): Promise<FolderRecord> {
  const { rows } = await pool.query(
    `INSERT INTO folders (name, user_id, parent_id)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [params.name, params.userId, params.parentId]
  );
  return mapFolderRow(rows[0]);
}

export async function getFolder(id: string): Promise<FolderRecord | null> {
  const { rows } = await pool.query('SELECT * FROM folders WHERE id = $1', [id]);
  return rows.length ? mapFolderRow(rows[0]) : null;
}

export async function renameFolder(id: string, name: string): Promise<FolderRecord> {
  const { rows } = await pool.query(
    `UPDATE folders SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [name, id]
  );
  return mapFolderRow(rows[0]);
}

export async function deleteFolder(id: string): Promise<void> {
  const hasChildren = await folderHasChildren(id);
  if (hasChildren) {
    const err = new Error('Folder is not empty') as Error & { statusCode: number };
    err.statusCode = 409;
    throw err;
  }
  await pool.query('DELETE FROM folders WHERE id = $1', [id]);
}

export async function folderHasChildren(id: string): Promise<boolean> {
  const filesResult = await pool.query(
    'SELECT 1 FROM files WHERE folder_id = $1 LIMIT 1',
    [id]
  );
  if (filesResult.rows.length > 0) return true;

  const foldersResult = await pool.query(
    'SELECT 1 FROM folders WHERE parent_id = $1 LIMIT 1',
    [id]
  );
  return foldersResult.rows.length > 0;
}

/**
 * Walks the ancestor chain from targetId upward to determine if sourceId
 * is an ancestor of targetId. Used to prevent circular references when
 * moving folders.
 */
export async function isDescendantOf(targetId: string, sourceId: string): Promise<boolean> {
  let current: string | null = targetId;
  while (current !== null) {
    if (current === sourceId) {
      return true;
    }
    const folder = await getFolder(current);
    if (!folder) {
      return false;
    }
    current = folder.parentId;
  }
  return false;
}

export async function moveFolder(id: string, parentId: string | null): Promise<FolderRecord> {
  const { rows } = await pool.query(
    `UPDATE folders SET parent_id = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [parentId, id]
  );
  return mapFolderRow(rows[0]);
}


// --- Row mappers ---

function mapFileRow(row: Record<string, unknown>): FileRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    mimeType: row.mime_type as string,
    sizeBytes: Number(row.size_bytes),
    userId: row.user_id as string,
    folderId: (row.folder_id as string) || null,
    s3Key: row.s3_key as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapFolderRow(row: Record<string, unknown>): FolderRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    userId: row.user_id as string,
    parentId: (row.parent_id as string) || null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}
