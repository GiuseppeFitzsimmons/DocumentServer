import { pool } from '../db/pool.js';
import { planBaseBytes } from '../membership/plans.js';

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
  // Usage = the user's current files only. Version history is deliberately NOT
  // counted: versions are a free feature (paid tiers will later get a higher
  // retained-version count). The number of versions kept per file is already
  // capped by MAX_VERSIONS_PER_FILE, which bounds what that costs us.
  const { rows } = await pool.query(
    `SELECT
       u.plan AS plan,
       u.referral_bonus_bytes AS bonus_bytes,
       u.storage_limit_override AS override_bytes,
       COALESCE((SELECT SUM(f.size_bytes) FROM files f WHERE f.user_id = u.id), 0)::bigint AS files_total
     FROM users u
     WHERE u.id = $1`,
    [userId]
  );

  // If the user row is missing, fall back to zero usage + default limit so
  // callers get a well-formed result rather than throwing.
  const usedBytes = rows.length ? Number(rows[0].files_total) : 0;

  // Effective limit resolution:
  //   1. storage_limit_override (per-account hard cap, e.g. test accounts)
  //   2. otherwise DERIVED: plan base (10 MB free / 100 MB storage_100) plus
  //      any permanent referral bonus. Keeping plan and referral credit in
  //      separate columns and summing here means Payhip plan changes and
  //      referral bonuses never clobber one another.
  let limitBytes: number;
  if (!rows.length) {
    limitBytes = ACCOUNT_QUOTA_BYTES;
  } else if (rows[0].override_bytes != null) {
    limitBytes = Number(rows[0].override_bytes);
  } else {
    limitBytes = planBaseBytes(rows[0].plan) + Number(rows[0].bonus_bytes ?? 0);
  }

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
