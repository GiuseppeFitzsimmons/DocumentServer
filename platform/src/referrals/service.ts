import crypto from 'crypto';
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { sendEmail } from '../email.js';
import { isDisposableEmail } from '../auth/disposable-email.js';
import { REFERRAL_BONUS_BYTES, planBaseBytes } from '../membership/plans.js';

export class ReferralError extends Error {}

/**
 * Create a pending, email-scoped referral invite for the given referrer and
 * send the friend an invite email with a single /r/<token> link. The reward is
 * granted later, when that exact email verifies (claimReferralOnVerification).
 */
export async function createInvite(referrerId: string, rawEmail: string): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new ReferralError('Please enter a valid email address.');
  }
  if (isDisposableEmail(email)) {
    throw new ReferralError('Disposable email addresses are not accepted.');
  }

  // Can't invite yourself or an address that already has an account.
  const self = await pool.query('SELECT LOWER(email) AS email FROM users WHERE id = $1', [referrerId]);
  if (self.rows[0]?.email === email) {
    throw new ReferralError('You cannot invite your own email address.');
  }
  const existing = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = $1', [email]);
  if (existing.rows.length > 0) {
    throw new ReferralError('That email already belongs to a EuroBureau account.');
  }

  const token = crypto.randomBytes(24).toString('base64url');
  try {
    await pool.query(
      `INSERT INTO referral_invites (referrer_id, invited_email, token)
       VALUES ($1, $2, $3)`,
      [referrerId, email, token]
    );
  } catch (err: any) {
    // uq_referral_pending: one live invite per (referrer, email).
    if (err?.code === '23505') {
      throw new ReferralError('You have already invited this address.');
    }
    throw err;
  }

  // Send the invite email WITHOUT blocking the HTTP response. The record above
  // is what matters (validation errors already surfaced); the email is a
  // best-effort side effect. Awaiting it made the request hang whenever the
  // SMTP relay was slow, surfacing as a socket timeout in the browser.
  const link = `${config.PUBLIC_BASE_URL.replace(/\/$/, '')}/r/${token}`;
  const text =
    `A friend has invited you to join EuroBureau. Sign up with this email (${email}) and ` +
    `you'll both get a free, permanent 10 MB storage boost.\n\n${link}`;
  void sendEmail({
    to: email,
    subject: 'Your friend invited you to EuroBureau (free storage for both of you)',
    html:
      `<p>A friend has invited you to join <strong>EuroBureau</strong>. Sign up with this email ` +
      `(<strong>${email}</strong>) and you'll both get a free, permanent 10&nbsp;MB storage boost.</p>` +
      `<p><a href="${link}">Accept your invite</a></p>`,
    text,
  }).catch((err) => console.error(`[referrals] invite email to ${email} failed:`, err));
}

export interface InviteSummary {
  invitedEmail: string;
  status: string;
  createdAt: Date;
  claimedAt: Date | null;
}

/** Invites the user has sent, newest first, for display on the account page. */
export async function listInvites(referrerId: string): Promise<InviteSummary[]> {
  const { rows } = await pool.query(
    `SELECT invited_email, status, created_at, claimed_at
       FROM referral_invites
      WHERE referrer_id = $1
      ORDER BY created_at DESC`,
    [referrerId]
  );
  return rows.map((r) => ({
    invitedEmail: r.invited_email,
    status: r.status,
    createdAt: r.created_at,
    claimedAt: r.claimed_at,
  }));
}

/** Resolve a /r/<token> link to its invited email, if the invite is live. */
export async function lookupInvite(token: string): Promise<{ invitedEmail: string } | null> {
  const { rows } = await pool.query(
    `SELECT invited_email FROM referral_invites WHERE token = $1 AND status = 'pending'`,
    [token]
  );
  return rows.length ? { invitedEmail: rows[0].invited_email } : null;
}

/** Add the one-time bonus to an account iff it hasn't banked one yet. */
async function creditOnce(userId: string): Promise<void> {
  await pool.query(
    `UPDATE users
        SET referral_bonus_bytes = $2::bigint,
            storage_limit_bytes =
              (CASE WHEN plan = 'storage_100'
                    THEN $3::bigint ELSE $4::bigint END) + $2::bigint,
            updated_at = NOW()
      WHERE id = $1 AND COALESCE(referral_bonus_bytes, 0) = 0`,
    [userId, REFERRAL_BONUS_BYTES, planBaseBytes('storage_100'), planBaseBytes('free')]
  );
}

/**
 * Called the instant a user's email becomes verified (beta approval today, the
 * self-serve verify endpoint from Dec 1). If a pending invite is scoped to this
 * exact email, mark it claimed and grant the one-time +10 MB to BOTH parties
 * (each capped at a single lifetime bonus). No-op when there's no live invite.
 */
export async function claimReferralOnVerification(newUserId: string, rawEmail: string): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  if (isDisposableEmail(email)) return;

  const { rows } = await pool.query(
    `SELECT id, referrer_id FROM referral_invites
      WHERE invited_email = $1 AND status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1`,
    [email]
  );
  if (!rows.length) return;

  const invite = rows[0];
  if (invite.referrer_id === newUserId) return; // defensive: no self-referral

  // Claim the invite first; if another concurrent verify already claimed it,
  // this updates 0 rows and we stop (prevents double credit).
  const claim = await pool.query(
    `UPDATE referral_invites
        SET status = 'claimed', invitee_id = $2, claimed_at = NOW()
      WHERE id = $1 AND status = 'pending'
      RETURNING id`,
    [invite.id, newUserId]
  );
  if (!claim.rowCount) return;

  // Void any other pending invites to this same address — it's now taken.
  await pool.query(
    `UPDATE referral_invites SET status = 'void'
      WHERE invited_email = $1 AND status = 'pending'`,
    [email]
  );

  await creditOnce(invite.referrer_id);
  await creditOnce(newUserId);
}
