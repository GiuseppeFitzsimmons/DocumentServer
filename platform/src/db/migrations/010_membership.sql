-- Per-user storage quota + membership plan. Enables paid tiers to raise a
-- user's storage limit without code changes (set storage_limit_bytes).
-- Free accounts default to 10 MB (10485760 bytes).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS storage_limit_bytes BIGINT NOT NULL DEFAULT 10485760,
  ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';

-- Backfill any pre-existing rows that somehow have NULL (defensive; the DEFAULT
-- above covers new and existing rows, but keep this explicit).
UPDATE users SET storage_limit_bytes = 10485760 WHERE storage_limit_bytes IS NULL;
UPDATE users SET plan = 'free' WHERE plan IS NULL;
