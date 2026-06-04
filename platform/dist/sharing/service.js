import { pool } from '../db/pool.js';
// --- Helper: create a typed error with status code ---
function createError(message, status) {
    const err = new Error(message);
    err.statusCode = status;
    return err;
}
// --- Row mapper ---
function mapShareRow(row) {
    return {
        id: row.id,
        fileId: row.file_id,
        ownerId: row.owner_id,
        inviteeId: row.invitee_id,
        permissions: {
            edit: row.perm_edit,
            download: row.perm_download,
            print: row.perm_print,
            copy: row.perm_copy,
            comment: row.perm_comment,
            review: row.perm_review,
            chat: row.perm_chat,
            fillForms: row.perm_fill_forms,
        },
        createdAt: new Date(row.created_at),
    };
}
// --- Validation ---
function validatePermissions(permissions) {
    const hasAtLeastOne = permissions.edit || permissions.download || permissions.print ||
        permissions.copy || permissions.comment || permissions.review ||
        permissions.chat || permissions.fillForms;
    if (!hasAtLeastOne) {
        throw createError('At least one permission must be granted', 400);
    }
}
// --- Service functions ---
export async function createShare(fileId, ownerId, inviteeEmail, permissions) {
    // Validate permissions
    validatePermissions(permissions);
    // Verify file ownership
    const fileResult = await pool.query('SELECT user_id FROM files WHERE id = $1', [fileId]);
    if (fileResult.rows.length === 0 || fileResult.rows[0].user_id !== ownerId) {
        throw createError('Forbidden', 403);
    }
    // Look up invitee by email
    const inviteeResult = await pool.query('SELECT id FROM users WHERE email = $1', [inviteeEmail]);
    if (inviteeResult.rows.length === 0) {
        throw createError('User not found', 404);
    }
    const inviteeId = inviteeResult.rows[0].id;
    // Cannot share with yourself
    if (inviteeId === ownerId) {
        throw createError('Cannot share a file with yourself', 400);
    }
    // Check for duplicate share
    const duplicateResult = await pool.query('SELECT id FROM file_shares WHERE file_id = $1 AND invitee_id = $2', [fileId, inviteeId]);
    if (duplicateResult.rows.length > 0) {
        throw createError('Share already exists', 409);
    }
    // Insert share record
    const { rows } = await pool.query(`INSERT INTO file_shares (file_id, owner_id, invitee_id, perm_edit, perm_download, perm_print, perm_copy, perm_comment, perm_review, perm_chat, perm_fill_forms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`, [
        fileId, ownerId, inviteeId,
        permissions.edit, permissions.download, permissions.print, permissions.copy,
        permissions.comment, permissions.review, permissions.chat, permissions.fillForms,
    ]);
    return mapShareRow(rows[0]);
}
export async function getShare(fileId, inviteeId) {
    const { rows } = await pool.query('SELECT * FROM file_shares WHERE file_id = $1 AND invitee_id = $2', [fileId, inviteeId]);
    return rows.length ? mapShareRow(rows[0]) : null;
}
export async function listSharesForFile(fileId, ownerId) {
    // Verify ownership
    const fileResult = await pool.query('SELECT user_id FROM files WHERE id = $1', [fileId]);
    if (fileResult.rows.length === 0 || fileResult.rows[0].user_id !== ownerId) {
        throw createError('Forbidden', 403);
    }
    const { rows } = await pool.query(`SELECT fs.*, u.email AS invitee_email, u.display_name AS invitee_display_name
     FROM file_shares fs
     JOIN users u ON u.id = fs.invitee_id
     WHERE fs.file_id = $1`, [fileId]);
    return rows.map((row) => ({
        ...mapShareRow(row),
        inviteeEmail: row.invitee_email,
        inviteeDisplayName: row.invitee_display_name,
    }));
}
export async function listSharedFiles(inviteeId) {
    const { rows } = await pool.query(`SELECT fs.*, f.name AS file_name, f.mime_type AS file_type, u.display_name AS owner_display_name
     FROM file_shares fs
     JOIN files f ON f.id = fs.file_id
     JOIN users u ON u.id = fs.owner_id
     WHERE fs.invitee_id = $1
     ORDER BY fs.created_at DESC`, [inviteeId]);
    return rows.map((row) => ({
        fileId: row.file_id,
        fileName: row.file_name,
        fileType: row.file_type,
        ownerDisplayName: row.owner_display_name,
        permissions: {
            edit: row.perm_edit,
            download: row.perm_download,
            print: row.perm_print,
            copy: row.perm_copy,
            comment: row.perm_comment,
            review: row.perm_review,
            chat: row.perm_chat,
            fillForms: row.perm_fill_forms,
        },
        sharedAt: new Date(row.created_at),
    }));
}
export async function updateSharePermissions(shareId, ownerId, permissions) {
    // Validate permissions
    validatePermissions(permissions);
    // Verify ownership of the share
    const shareResult = await pool.query('SELECT * FROM file_shares WHERE id = $1', [shareId]);
    if (shareResult.rows.length === 0) {
        throw createError('Share not found', 404);
    }
    if (shareResult.rows[0].owner_id !== ownerId) {
        throw createError('Forbidden', 403);
    }
    // Update permissions
    const { rows } = await pool.query(`UPDATE file_shares
     SET perm_edit = $1, perm_download = $2, perm_print = $3, perm_copy = $4,
         perm_comment = $5, perm_review = $6, perm_chat = $7, perm_fill_forms = $8
     WHERE id = $9
     RETURNING *`, [
        permissions.edit, permissions.download, permissions.print, permissions.copy,
        permissions.comment, permissions.review, permissions.chat, permissions.fillForms,
        shareId,
    ]);
    return mapShareRow(rows[0]);
}
export async function revokeShare(shareId, ownerId) {
    // Verify the share exists and ownership
    const shareResult = await pool.query('SELECT owner_id FROM file_shares WHERE id = $1', [shareId]);
    if (shareResult.rows.length === 0) {
        throw createError('Share not found', 404);
    }
    if (shareResult.rows[0].owner_id !== ownerId) {
        throw createError('Forbidden', 403);
    }
    await pool.query('DELETE FROM file_shares WHERE id = $1', [shareId]);
}
export async function deleteSharesForFile(fileId) {
    await pool.query('DELETE FROM file_shares WHERE file_id = $1', [fileId]);
}
export async function listShareUsersForFile(fileId, userId) {
    // Check if user is the file owner
    const fileResult = await pool.query('SELECT user_id FROM files WHERE id = $1', [fileId]);
    if (fileResult.rows.length === 0) {
        throw createError('Forbidden', 403);
    }
    const isOwner = fileResult.rows[0].user_id === userId;
    // If not owner, check if user has a share record for this file
    if (!isOwner) {
        const shareResult = await pool.query('SELECT id FROM file_shares WHERE file_id = $1 AND invitee_id = $2', [fileId, userId]);
        if (shareResult.rows.length === 0) {
            throw createError('Forbidden', 403);
        }
    }
    // Fetch owner info
    const ownerResult = await pool.query('SELECT id, display_name AS name, email FROM users WHERE id = $1', [fileResult.rows[0].user_id]);
    // Fetch all invitees for this file
    const inviteesResult = await pool.query(`SELECT u.id, u.display_name AS name, u.email
     FROM file_shares fs
     JOIN users u ON u.id = fs.invitee_id
     WHERE fs.file_id = $1`, [fileId]);
    // Return owner first, then all invitees
    const owner = ownerResult.rows[0];
    const participants = [
        { id: owner.id, name: owner.name, email: owner.email },
        ...inviteesResult.rows.map((row) => ({
            id: row.id,
            name: row.name,
            email: row.email,
        })),
    ];
    return participants;
}
//# sourceMappingURL=service.js.map