import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { listFolder, getRecentFiles } from '../storage/metadata.js';
import { pool } from '../db/pool.js';
import { getAccountUsage } from '../storage/quota.js';

export const landingRouter = Router();

landingRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const userId = req.session.userId!;

    const [folderContents, recentFiles, userResult, quota] = await Promise.all([
      listFolder(userId, null),
      getRecentFiles(userId, 10),
      pool.query('SELECT display_name FROM users WHERE id = $1', [userId]),
      getAccountUsage(userId),
    ]);

    const displayName = userResult.rows[0]?.display_name || 'User';

    function formatBytes(bytes: number): string {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    res.render('landing', {
      layout: false,
      initialItems: JSON.stringify(folderContents),
      recentFiles: JSON.stringify(recentFiles),
      displayName,
      quotaUsed: formatBytes(quota.usedBytes),
      quotaLimit: formatBytes(quota.limitBytes),
      quotaPercentage: quota.percentage,
    });
  } catch (err) {
    next(err);
  }
});
