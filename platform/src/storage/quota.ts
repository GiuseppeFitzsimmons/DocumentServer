import { pool } from '../db/pool.js';

// 40 MB account storage limit
export const ACCOUNT_QUOTA_BYTES = 40 * 1024 * 1024;
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
    'SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total FROM files WHERE user_id = $1',
    [userId]
  );
  const usedBytes = Number(rows[0].total);
  const percentage = usedBytes / ACCOUNT_QUOTA_BYTES;

  return {
    usedBytes,
    limitBytes: ACCOUNT_QUOTA_BYTES,
    percentage: Math.min(percentage, 1),
    isWarning: percentage >= QUOTA_WARNING_THRESHOLD,
    isFull: usedBytes >= ACCOUNT_QUOTA_BYTES,
  };
}
