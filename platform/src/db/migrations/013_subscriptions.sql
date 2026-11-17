-- Payhip subscriptions (recurring 100 MB storage). Payhip does NOT send a
-- per-renewal webhook — only subscription.created and subscription.deleted — so
-- we self-renew: a background job rolls current_period_end forward every 30
-- days for as long as the subscription is 'active'. Cancellation flips status
-- to 'canceled' and STOPS the renewal, but leaves current_period_end intact so
-- the customer keeps the remainder of the period they already paid for.
--
-- Guiding rule: never lapse an active subscription. The renewal roll-forward is
-- generous (self-heals after downtime, rolls to a future boundary), erring
-- toward giving free time rather than ever dropping a paying customer.
CREATE TABLE IF NOT EXISTS membership_subscriptions (
  subscription_id    TEXT PRIMARY KEY,          -- Payhip subscription_id
  email              TEXT NOT NULL,             -- lowercased
  plan               TEXT NOT NULL DEFAULT 'storage_100',
  status             TEXT NOT NULL DEFAULT 'active', -- active | canceled
  current_period_end TIMESTAMPTZ NOT NULL,      -- rolls forward while active
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  canceled_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_membership_subscriptions_email
  ON membership_subscriptions (email);
