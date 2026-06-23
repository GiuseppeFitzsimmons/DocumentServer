/**
 * Nightly backup job
 *
 * Sends an email to each user who has nightly_backup enabled,
 * containing all their files modified since midnight (UTC) as attachments.
 *
 * Designed to be run via: node dist/jobs/nightly-backup.js
 */

import 'dotenv/config';
import { pool } from '../db/pool.js';
import { sendEmail } from '../email.js';
import * as storage from '../storage/s3.js';

async function run() {
  console.log('[nightly-backup] Starting...');

  // Get all users with nightly backup enabled
  const usersResult = await pool.query(
    'SELECT id, email, display_name FROM users WHERE nightly_backup = true'
  );

  if (usersResult.rows.length === 0) {
    console.log('[nightly-backup] No users opted in. Done.');
    process.exit(0);
  }

  // Get midnight UTC yesterday (since the job runs just after midnight, we want yesterday's edits)
  const now = new Date();
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  for (const user of usersResult.rows) {
    try {
      // Find files modified yesterday (between yesterday midnight and today midnight)
      const filesResult = await pool.query(
        'SELECT id, name, mime_type, s3_key FROM files WHERE user_id = $1 AND updated_at >= $2 AND updated_at < $3',
        [user.id, yesterday, today]
      );

      if (filesResult.rows.length === 0) {
        console.log(`[nightly-backup] ${user.email}: no modified files, skipping.`);
        continue;
      }

      // Download each file and build attachments
      const attachments: { filename: string; content: Buffer; contentType: string }[] = [];

      for (const file of filesResult.rows) {
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
          console.error(`[nightly-backup] Failed to read file ${file.id}:`, err);
        }
      }

      if (attachments.length === 0) {
        console.log(`[nightly-backup] ${user.email}: all file reads failed, skipping.`);
        continue;
      }

      const dateStr = yesterday.toLocaleDateString('en-GB', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });

      await sendEmail({
        to: user.email,
        subject: `Euro Bureau - Nightly backup (${dateStr})`,
        text: [
          `Hi ${user.display_name},`,
          ``,
          `Here are your ${attachments.length} file(s) modified today, attached at their latest version.`,
          ``,
          `Best regards,`,
          `Euro Bureau`,
        ].join('\n'),
        html: [
          `<p>Hi ${user.display_name},</p>`,
          `<p>Here are your <strong>${attachments.length}</strong> file(s) modified today, attached at their latest version.</p>`,
          `<p>Best regards,<br>Euro Bureau</p>`,
        ].join('\n'),
        attachments,
      });

      console.log(`[nightly-backup] ${user.email}: sent ${attachments.length} file(s).`);
    } catch (err) {
      console.error(`[nightly-backup] Error processing user ${user.email}:`, err);
    }
  }

  console.log('[nightly-backup] Done.');
  process.exit(0);
}

run().catch((err) => {
  console.error('[nightly-backup] Fatal error:', err);
  process.exit(1);
});
