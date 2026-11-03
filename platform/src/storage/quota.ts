import { pool } from '../db/pool.js';

// Default account storage limit (10 MB) for users without an explicit override.
// Per-user limits live in users.storage_limit_bytes; this is the fallback used
// when that column is null (and the baseline the migration seeds free accounts
// with).
//
// Local testing: set QUOTA_LIMIT_BYTES in the environment to override the
// default fallback cap (e.g. a tiny value to exercise near-cap behaviour
// without uploading megabytes). Per-user DB overrides still take precedence.
export const ACCOUNT_QUOTA_BYTES = (() => {
  const raw = process.env.QUOTA_LIMIT_BYTES;
  const parsed = raw != null ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 1024 * 1024;
})();

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
  // Usage = current files + retained version blobs. Version history consumes
  // real object storage, so it must count against the quota or the stated cap
  // understates actual usage (a near-cap document edited repeatedly can retain
  // several versions). Both sums are scoped to the user.
  const { rows } = await pool.query(
    `SELECT
       u.storage_limit_bytes AS limit_bytes,
       COALESCE((SELECT SUM(f.size_bytes) FROM files f WHERE f.user_id = u.id), 0)::bigint AS files_total,
       COALESCE((
         SELECT SUM(v.size_bytes)
         FROM file_versions v
         JOIN files f2 ON f2.id = v.file_id
         WHERE f2.user_id = u.id
       ), 0)::bigint AS versions_total
     FROM users u
     WHERE u.id = $1`,
    [userId]
  );

  // If the user row is missing, fall back to zero usage + default limit so
  // callers get a well-formed result rather than throwing.
  const usedBytes = rows.length
    ? Number(rows[0].files_total) + Number(rows[0].versions_total)
    : 0;
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

export interface QuotaCheck {
  ok: boolean;
  quota: QuotaInfo;
  // Projected total usage after the operation (bytes).
  projectedBytes: number;
}

/**
 * Projects account usage after storing `incomingBytes`, optionally replacing an
 * existing object of `replacingBytes` (e.g. overwriting a file on save). Returns
 * ok=false when the projection would exceed the account limit.
 *
 * This is the single source of truth for "will it fit" — use it on every ingest
 * path (upload, create, save-as, editor save) so enforcement is consistent.
 */
export async function checkQuota(
  userId: string,
  incomingBytes: number,
  replacingBytes = 0
): Promise<QuotaCheck> {
  const quota = await getAccountUsage(userId);
  const projectedBytes = quota.usedBytes - replacingBytes + incomingBytes;
  return {
    ok: projectedBytes <= quota.limitBytes,
    quota,
    projectedBytes,
  };
}
