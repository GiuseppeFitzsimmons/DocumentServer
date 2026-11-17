import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { requireAuth } from '../auth/middleware.js';
import { sendEmail } from '../email.js';
import * as storage from '../storage/s3.js';
import * as metadata from '../storage/metadata.js';
import { deleteSharesForFile } from '../sharing/service.js';
import * as versionRepo from '../versions/repository.js';
import { getAccountUsage } from '../storage/quota.js';

export const accountRouter = Router();
export const accountPageRouter = Router();

// --- Page route ---

accountPageRouter.get('/account', requireAuth, async (req, res) => {
  const userId = req.session.userId!;
  const result = await pool.query(
    'SELECT email, display_name, created_at, nightly_backup, plan, referral_bonus_bytes FROM users WHERE id = $1',
    [userId]
  );

  if (result.rows.length === 0) {
    res.redirect('/login');
    return;
  }

  const user = result.rows[0];

  // Paid-storage end date and whether it's a subscription that's been canceled
  // (so we can word it "won't renew"). The end date is the furthest-out of:
  //   - any unexpired one-off grant (single-month purchase), and
  //   - any subscription still within its paid period.
  // An active subscription self-renews, so it effectively has no end date; a
  // canceled subscription shows the date its remaining period runs out.
  const grant = await pool.query(
    `SELECT MAX(expires_at) AS end_at
       FROM membership_grants
      WHERE email = LOWER($1) AND expires_at > NOW()`,
    [user.email]
  );
  const sub = await pool.query(
    `SELECT status, current_period_end
       FROM membership_subscriptions
      WHERE email = LOWER($1) AND current_period_end > NOW()
      ORDER BY current_period_end DESC
      LIMIT 1`,
    [user.email]
  );

  const grantEnd = (grant.rows[0]?.end_at as Date | null) ?? null;
  const subRow = sub.rows[0] as { status: string; current_period_end: Date } | undefined;
  const subActive = subRow?.status === 'active';
  const subCanceled = subRow?.status === 'canceled';

  const fmtDate = (d: Date) =>
    new Date(d).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });

  // An active subscription renews indefinitely — no end date shown. Otherwise
  // show the furthest paid-through date (canceled sub period or one-off grant).
  let storageEndsAt: string | null = null;
  let storageRenews = false;
  let storageCanceledEndsAt: string | null = null;
  if (subActive) {
    storageRenews = true;
  } else {
    const candidates = [grantEnd, subCanceled ? subRow!.current_period_end : null].filter(Boolean) as Date[];
    if (candidates.length) {
      const furthest = candidates.reduce((a, b) => (a > b ? a : b));
      storageEndsAt = fmtDate(furthest);
      if (subCanceled && (!grantEnd || subRow!.current_period_end >= grantEnd)) {
        storageCanceledEndsAt = fmtDate(subRow!.current_period_end);
      }
    }
  }
  const createdAt = new Date(user.created_at).toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const quota = await getAccountUsage(userId);

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  res.render('account', {
    title: 'Account',
    email: user.email,
    displayName: user.display_name,
    createdAt,
    nightlyBackup: user.nightly_backup,
    quotaPercentage: quota.percentage,
    quotaUsed: formatBytes(quota.usedBytes),
    quotaLimit: formatBytes(quota.limitBytes),
    plan: user.plan,
    storageEndsAt,
    storageRenews,
    storageCanceledEndsAt,
    referralBonusEarned: Number(user.referral_bonus_bytes ?? 0) > 0,
    layout: false,
  });
});

// --- API routes ---

accountRouter.use(requireAuth);

// POST /api/account/name
accountRouter.post('/name', async (req, res) => {
  const schema = z.object({ displayName: z.string().min(1).max(100) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Display name must be between 1 and 100 characters.' });
    return;
  }

  const userId = req.session.userId!;
  const { displayName } = parsed.data;

  await pool.query('UPDATE users SET display_name = $1, updated_at = NOW() WHERE id = $2', [displayName, userId]);
  res.json({ success: true, displayName });
});

// POST /api/account/nightly-backup
accountRouter.post('/nightly-backup', async (req, res) => {
  const schema = z.object({ enabled: z.boolean() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input.' });
    return;
  }

  const userId = req.session.userId!;
  const { enabled } = parsed.data;

  await pool.query('UPDATE users SET nightly_backup = $1, updated_at = NOW() WHERE id = $2', [enabled, userId]);
  res.json({ success: true, enabled });
});

// POST /api/account/password
accountRouter.post('/password', async (req, res) => {
  const schema = z.object({
    currentPassword: z.string(),
    newPassword: z.string().min(8),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'New password must be at least 8 characters.' });
    return;
  }

  const userId = req.session.userId!;
  const { currentPassword, newPassword } = parsed.data;

  const userResult = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (userResult.rows.length === 0) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const valid = await verifyPassword(userResult.rows[0].password_hash, currentPassword);
  if (!valid) {
    res.status(403).json({ error: 'Current password is incorrect.' });
    return;
  }

  const newHash = await hashPassword(newPassword);
  await pool.query('UPDATE users SET password_hash = $1, is_temp_password = false, updated_at = NOW() WHERE id = $2', [newHash, userId]);
  res.json({ success: true });
});

// POST /api/account/delete
accountRouter.post('/delete', async (req, res) => {
  const schema = z.object({ password: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Password is required.' });
    return;
  }

  const userId = req.session.userId!;
  const { password } = parsed.data;

  // Verify password
  const userResult = await pool.query('SELECT id, email, display_name, password_hash FROM users WHERE id = $1', [userId]);
  if (userResult.rows.length === 0) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const user = userResult.rows[0];
  const valid = await verifyPassword(user.password_hash, password);
  if (!valid) {
    res.status(403).json({ error: 'Password is incorrect.' });
    return;
  }

  try {
    // 1. Get all user files
    const filesResult = await pool.query('SELECT * FROM files WHERE user_id = $1', [userId]);
    const files = filesResult.rows;

    // 2. Email backup of all files as attachments
    if (files.length > 0) {
      const attachments: { filename: string; content: Buffer; contentType: string }[] = [];

      for (const file of files) {
        try {
          const stream = await storage.download(file.s3_key);
          const chunks: Buffer[] = [];
          for await (const chunk of stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          attachments.push({
            filename: file.name,
            content: Buffer.concat(chunks),
            contentType: file.mime_type,
          });
        } catch (err) {
          console.error(`Failed to read file ${file.id} for backup:`, err);
        }
      }

      if (attachments.length > 0) {
        await sendEmail({
          to: user.email,
          subject: 'Euro Bureau - Your file backup (account deletion)',
          text: `Hi ${user.display_name},\n\nAs requested, here are all your files from Euro Bureau. Your account has been deleted.\n\nBest regards,\nEuro Bureau`,
          html: `<p>Hi ${user.display_name},</p><p>As requested, here are all your files from Euro Bureau. Your account has been deleted.</p><p>Best regards,<br>Euro Bureau</p>`,
          attachments,
        });
      }
    }

    // 3. Delete all files from storage (local + S3 replica)
    for (const file of files) {
      // Delete version files
      const versions = await versionRepo.listVersions(file.id);
      for (const version of versions) {
        await storage.remove(version.s3Key);
        if (version.changesS3Key) {
          await storage.remove(version.changesS3Key);
        }
      }
      // Delete shares
      await deleteSharesForFile(file.id);
      // Delete the main file
      await storage.remove(file.s3_key);
    }

    // 4. Delete all database records (cascading from user deletion handles most)
    // Delete files and folders explicitly
    await pool.query('DELETE FROM files WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM folders WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [userId]);

    // 5. Delete the user
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);

    // 6. Destroy session
    req.session.destroy(() => {
      res.clearCookie('sid');
      res.json({ success: true });
    });
  } catch (err) {
    console.error('Account deletion error:', err);
    res.status(500).json({ error: 'Failed to delete account. Please try again or contact support.' });
  }
});
