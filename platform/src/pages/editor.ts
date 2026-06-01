import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { getFile } from '../storage/metadata.js';
import { buildEditorConfig } from '../ds/editorConfig.js';
import { pool } from '../db/pool.js';
import { config } from '../config.js';

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
    if (file.userId !== userId) {
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
    });

    res.render('editor', {
      title: file.name,
      editorConfig,
      dsUrl: '',
      layout: false,
    });
  } catch (err) {
    console.error('Editor page error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
