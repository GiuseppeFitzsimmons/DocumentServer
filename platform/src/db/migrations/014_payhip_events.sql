-- Raw log of every Payhip webhook we accept (signature-verified). Lets us see
-- exactly what Payhip sends — crucial for confirming whether a subscription
-- RENEWAL fires any webhook at all (the docs don't say). Keep the whole body so
-- we can inspect fields we don't yet parse.
CREATE TABLE IF NOT EXISTS payhip_events (
  id            BIGSERIAL PRIMARY KEY,
  event_type    TEXT,                          -- paid | refunded | subscription.created | subscription.deleted | (unknown)
  source_ref    TEXT,                          -- transaction id or subscription id, when present
  email         TEXT,                          -- buyer/customer email, when present
  payload       JSONB NOT NULL,                -- full event body as received
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payhip_events_type ON payhip_events (event_type);
CREATE INDEX IF NOT EXISTS idx_payhip_events_received ON payhip_events (received_at DESC);
