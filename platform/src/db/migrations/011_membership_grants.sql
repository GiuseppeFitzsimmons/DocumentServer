-- Paid storage grants, one row per Payhip charge. A user's plan is derived
-- from whether they hold an unexpired, unrefunded grant. Keyed by email so a
-- purchase made before the account exists (or under a mismatched address) is
-- still recorded and applies once the emails line up.
CREATE TABLE IF NOT EXISTS membership_grants (
  id            BIGSERIAL PRIMARY KEY,
  source_ref    TEXT NOT NULL UNIQUE,       -- Payhip transaction id (idempotency key)
  email         TEXT NOT NULL,              -- lowercased
  plan          TEXT NOT NULL,
  subscription_id TEXT,
  starts_at     TIMESTAMPTZ NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  refunded_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_membership_grants_email ON membership_grants (email);
