import { pool } from '../db/pool.js';
// --- File operations ---
export async function createFile(params) {
    const { rows } = await pool.query(`INSERT INTO files (name, mime_type, size_bytes, user_id, folder_id, s3_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`, [params.name, params.mimeType, params.sizeBytes, params.userId, params.folderId, params.s3Key]);
    return mapFileRow(rows[0]);
}
export async function getFile(id) {
    const { rows } = await pool.query('SELECT * FROM files WHERE id = $1', [id]);
    return rows.length ? mapFileRow(rows[0]) : null;
}
export async function updateFile(id, updates) {
    const setClauses = [];
    const values = [];
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
    const { rows } = await pool.query(`UPDATE files SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`, values);
    return mapFileRow(rows[0]);
}
export async function deleteFile(id) {
    await pool.query('DELETE FROM files WHERE id = $1', [id]);
}
export async function listFolder(userId, folderId) {
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
export async function getRecentFiles(userId, limit) {
    const { rows } = await pool.query('SELECT * FROM files WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2', [userId, limit]);
    return rows.map(mapFileRow);
}
// --- Folder operations ---
export async function createFolder(params) {
    const { rows } = await pool.query(`INSERT INTO folders (name, user_id, parent_id)
     VALUES ($1, $2, $3)
     RETURNING *`, [params.name, params.userId, params.parentId]);
    return mapFolderRow(rows[0]);
}
export async function getFolder(id) {
    const { rows } = await pool.query('SELECT * FROM folders WHERE id = $1', [id]);
    return rows.length ? mapFolderRow(rows[0]) : null;
}
export async function renameFolder(id, name) {
    const { rows } = await pool.query(`UPDATE folders SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING *`, [name, id]);
    return mapFolderRow(rows[0]);
}
export async function deleteFolder(id) {
    const hasChildren = await folderHasChildren(id);
    if (hasChildren) {
        const err = new Error('Folder is not empty');
        err.statusCode = 409;
        throw err;
    }
    await pool.query('DELETE FROM folders WHERE id = $1', [id]);
}
export async function folderHasChildren(id) {
    const filesResult = await pool.query('SELECT 1 FROM files WHERE folder_id = $1 LIMIT 1', [id]);
    if (filesResult.rows.length > 0)
        return true;
    const foldersResult = await pool.query('SELECT 1 FROM folders WHERE parent_id = $1 LIMIT 1', [id]);
    return foldersResult.rows.length > 0;
}
/**
 * Walks the ancestor chain from targetId upward to determine if sourceId
 * is an ancestor of targetId. Used to prevent circular references when
 * moving folders.
 */
export async function isDescendantOf(targetId, sourceId) {
    let current = targetId;
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
export async function moveFolder(id, parentId) {
    const { rows } = await pool.query(`UPDATE folders SET parent_id = $1, updated_at = NOW() WHERE id = $2 RETURNING *`, [parentId, id]);
    return mapFolderRow(rows[0]);
}
/**
 * Walks parentId links upward from the given folder to build the ancestor chain.
 * Returns an array ordered from root (topmost ancestor) to the given folder itself.
 */
export async function getAncestors(folderId) {
    const ancestors = [];
    let current = folderId;
    while (current !== null) {
        const folder = await getFolder(current);
        if (!folder) {
            break;
        }
        ancestors.push(folder);
        current = folder.parentId;
    }
    // Reverse so the array goes from root to the given folder
    return ancestors.reverse();
}
/**
 * Fetches all folders belonging to a user. Used by the tree builder to assemble
 * the full folder hierarchy in memory.
 */
export async function getAllUserFolders(userId) {
    const { rows } = await pool.query('SELECT * FROM folders WHERE user_id = $1', [userId]);
    return rows.map(mapFolderRow);
}
// --- Row mappers ---
function mapFileRow(row) {
    return {
        id: row.id,
        name: row.name,
        mimeType: row.mime_type,
        sizeBytes: Number(row.size_bytes),
        userId: row.user_id,
        folderId: row.folder_id || null,
        s3Key: row.s3_key,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
    };
}
function mapFolderRow(row) {
    return {
        id: row.id,
        name: row.name,
        userId: row.user_id,
        parentId: row.parent_id || null,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
    };
}
//# sourceMappingURL=metadata.js.map