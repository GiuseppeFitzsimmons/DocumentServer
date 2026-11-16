-- Invite-a-friend referrals. Each successful, email-verified referral grants a
-- permanent +10 MB to BOTH the referrer and the invitee, once per account for
-- life (a user's referral_bonus_bytes caps at a single 10 MB increment).
--
-- Effective storage limit is DERIVED (see storage/quota.ts) as
--   plan_base (10 MB free / 100 MB storage_100) + referral_bonus_bytes
-- so that paid-plan changes (Payhip) and referral bonuses never clobber each
-- other on the single users.storage_limit_bytes column.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS referral_bonus_bytes BIGINT NOT NULL DEFAULT 0,
  -- Optional hard override of the derived limit. NULL = derive from plan +
  -- referral bonus (the normal case). Set only for special/test accounts that
  -- need a fixed cap regardless of plan (e.g. the local quota test account).
  ADD COLUMN IF NOT EXISTS storage_limit_override BIGINT;

CREATE TABLE IF NOT EXISTS referral_invites (
  id            BIGSERIAL PRIMARY KEY,
  referrer_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_email TEXT NOT NULL,                 -- lowercased; the reward is scoped to this address
  token         TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | claimed | void
  invitee_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_referral_invites_email ON referral_invites (invited_email);
CREATE INDEX IF NOT EXISTS idx_referral_invites_referrer ON referral_invites (referrer_id);
-- A referrer can only have one live (pending) invite outstanding per address.
CREATE UNIQUE INDEX IF NOT EXISTS uq_referral_pending
  ON referral_invites (referrer_id, invited_email)
  WHERE status = 'pending';
