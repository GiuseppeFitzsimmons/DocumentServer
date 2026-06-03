import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { getFile } from '../storage/metadata.js';
import { buildEditorConfig } from '../ds/editorConfig.js';
import { getShare } from '../sharing/service.js';
import { pool } from '../db/pool.js';

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

    // If the user is not the owner, check for a share record
    if (!isOwner) {
      const share = await getShare(fileId, userId);
      if (!share) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }

      // Get user display name
      const userResult = await pool.query(
        'SELECT display_name FROM users WHERE id = $1',
        [userId]
      );
      const displayName = userResult.rows[0]?.display_name ?? 'User';

      const editorConfig = buildEditorConfig({
        file,
        user: { id: userId, name: displayName },
        sharePermissions: share.permissions,
      });

      res.render('editor', {
        title: file.name,
        editorConfig,
        dsUrl: '',
        fileId: fileId,
        layout: false,
      });
      return;
    }

    // Owner path: full permissions
    const userResult = await pool.query(
      'SELECT display_name FROM users WHERE id = $1',
      [userId]
    );
    const displayName = userResult.rows[0]?.display_name ?? 'User';

    const editorConfig = buildEditorConfig({
      file,
      user: { id: userId, name: displayName },
    });

    res.render('editor', {
      title: file.name,
      editorConfig,
      dsUrl: '',
      fileId: fileId,
      layout: false,
    });
  } catch (err) {
    console.error('Editor page error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
