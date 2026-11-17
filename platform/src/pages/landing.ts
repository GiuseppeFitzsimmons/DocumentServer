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
      pool.query('SELECT display_name, email, plan FROM users WHERE id = $1', [userId]),
      getAccountUsage(userId),
    ]);

    const displayName = userResult.rows[0]?.display_name || 'User';
    const email = userResult.rows[0]?.email as string | undefined;
    const plan = userResult.rows[0]?.plan as string | undefined;

    // Warn storage_100 users a few days before their paid storage lapses — but
    // NOT when they hold an active (auto-renewing) subscription, which never
    // lapses. The warning targets single-month buyers and canceled subs winding
    // down. storageEndsInDays is whole days until the furthest paid-through
    // date; null when free, or when an active subscription covers them.
    let storageEndsInDays: number | null = null;
    if (plan === 'storage_100' && email) {
      const activeSub = await pool.query(
        `SELECT 1 FROM membership_subscriptions
          WHERE email = LOWER($1) AND status = 'active' AND current_period_end > NOW()
          LIMIT 1`,
        [email]
      );
      if (activeSub.rows.length === 0) {
        const { rows } = await pool.query(
          `SELECT GREATEST(
                    COALESCE((SELECT MAX(expires_at) FROM membership_grants
                               WHERE email = LOWER($1) AND expires_at > NOW()), 'epoch'),
                    COALESCE((SELECT MAX(current_period_end) FROM membership_subscriptions
                               WHERE email = LOWER($1) AND current_period_end > NOW()), 'epoch')
                  ) AS end_at`,
          [email]
        );
        const endAt = rows[0]?.end_at as Date | null;
        if (endAt && endAt.getTime() > 0) {
          storageEndsInDays = Math.ceil((endAt.getTime() - Date.now()) / 86400_000);
        }
      }
    }

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
      isOverCap: quota.isFull,
      storageEndsInDays,
    });
  } catch (err) {
    next(err);
  }
});
