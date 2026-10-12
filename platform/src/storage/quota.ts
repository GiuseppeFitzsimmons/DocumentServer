import { pool } from '../db/pool.js';

// Default account storage limit (10 MB) for users without an explicit override.
// Per-user limits live in users.storage_limit_bytes; this is the fallback used
// when that column is null (and the baseline the migration seeds free accounts
// with).
export const ACCOUNT_QUOTA_BYTES = 10 * 1024 * 1024;
// Warning threshold: 80%
export const QUOTA_WARNING_THRESHOLD = 0.8;

export interface QuotaInfo {
  usedBytes: number;
  limitBytes: number;
  percentage: number;
  isWarning: boolean;
  isFull: boolean;
}

export async function getAccountUsage(userId: string): Promise<QuotaInfo> {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(f.size_bytes), 0)::bigint AS total,
       u.storage_limit_bytes AS limit_bytes
     FROM users u
     LEFT JOIN files f ON f.user_id = u.id
     WHERE u.id = $1
     GROUP BY u.storage_limit_bytes`,
    [userId]
  );

  // If the user row is missing, fall back to zero usage + default limit so
  // callers get a well-formed result rather than throwing.
  const usedBytes = rows.length ? Number(rows[0].total) : 0;
  const limitBytes =
    rows.length && rows[0].limit_bytes != null
      ? Number(rows[0].limit_bytes)
      : ACCOUNT_QUOTA_BYTES;

  const percentage = limitBytes > 0 ? usedBytes / limitBytes : 1;

  return {
    usedBytes,
    limitBytes,
    percentage: Math.min(percentage, 1),
    isWarning: percentage >= QUOTA_WARNING_THRESHOLD,
    isFull: usedBytes >= limitBytes,
  };
}
