import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { getFile } from '../storage/metadata.js';
import { buildEditorConfig } from '../ds/editorConfig.js';
import type { SharingSettingsEntry } from '../ds/editorConfig.js';
import { getShare, listSharesForFile, type SharePermissions } from '../sharing/service.js';
import { pool } from '../db/pool.js';
import { getLatestVersionNumber } from '../versions/repository.js';
import { config } from '../config.js';
import { markDocumentOpen } from '../ds/active-documents.js';

export function summarizePermissions(p: SharePermissions): string {
  if (p.edit && p.download && p.print && p.copy && p.comment && p.review && p.chat && p.fillForms) {
    return 'Full Access';
  }
  if (p.edit) return 'Edit';
  if (p.comment) return 'Comment Only';
  return 'View Only';
}

export const editorRouter = Router();

editorRouter.get('/editor/:fileId', requireAuth, async (req, res) => {
  const fileId = req.params.fileId as string;
  const userId = req.session.userId!;

  try {
    const file = await getFile(fileId);
    if (!file) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const isOwner = file.userId === userId;

    // Get current user's display name
    const userResult = await pool.query(
      'SELECT display_name FROM users WHERE id = $1',
      [userId]
    );
    const displayName = userResult.rows[0]?.display_name ?? 'User';

    // Get owner display name
    let ownerDisplayName: string;
    if (isOwner) {
      ownerDisplayName = displayName;
    } else {
      const ownerResult = await pool.query(
        'SELECT display_name FROM users WHERE id = $1',
        [file.userId]
      );
      ownerDisplayName = ownerResult.rows[0]?.display_name ?? 'Owner';
    }

    // Query shares for the file and build sharingSettings array
    const shares = await listSharesForFile(fileId, file.userId);
    const sharingSettings: SharingSettingsEntry[] = [
      { user: ownerDisplayName, permissions: 'Full Access', isLink: false },
      ...shares.map((share) => ({
        user: share.inviteeDisplayName,
        permissions: summarizePermissions(share.permissions),
        isLink: false,
      })),
    ];

    // If the user is not the owner, check for a share record
    if (!isOwner) {
      const share = await getShare(fileId, userId);
      if (!share) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      const hasVersions = (await getLatestVersionNumber(fileId)) > 0;

      const editorConfig = buildEditorConfig({
        file,
        user: { id: userId, name: displayName },
        sharePermissions: share.permissions,
        sharingSettings,
        isOwner,
        hasVersions,
      });

      // Track this document as actively open for forcesave
      const documentKey = `${file.id}_${file.updatedAt.getTime()}`;
      markDocumentOpen(fileId, documentKey).catch((err) =>
        console.error('[editor] Failed to mark document open:', err)
      );

      res.render('editor', {
        title: file.name,
        editorConfig,
        dsUrl: config.NODE_ENV === 'development' ? config.DS_URL : '',
        fileId: fileId,
        isOwner,
        ownerName: ownerDisplayName,
        layout: false,
      });
      return;
    }

    // Owner path: full permissions
    const hasVersions = (await getLatestVersionNumber(fileId)) > 0;

    const editorConfig = buildEditorConfig({
      file,
      user: { id: userId, name: displayName },
      sharingSettings,
      isOwner,
      hasVersions,
    });

    // Track this document as actively open for forcesave
    const documentKey = `${file.id}_${file.updatedAt.getTime()}`;
    markDocumentOpen(fileId, documentKey).catch((err) =>
      console.error('[editor] Failed to mark document open:', err)
    );

    res.render('editor', {
      title: file.name,
      editorConfig,
      dsUrl: config.NODE_ENV === 'development' ? config.DS_URL : '',
      fileId: fileId,
      isOwner,
      ownerName: ownerDisplayName,
      layout: false,
    });
  } catch (err) {
    console.error('Editor page error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
