CREATE TABLE IF NOT EXISTS file_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  perm_edit BOOLEAN NOT NULL DEFAULT false,
  perm_download BOOLEAN NOT NULL DEFAULT false,
  perm_print BOOLEAN NOT NULL DEFAULT false,
  perm_copy BOOLEAN NOT NULL DEFAULT false,
  perm_comment BOOLEAN NOT NULL DEFAULT false,
  perm_review BOOLEAN NOT NULL DEFAULT false,
  perm_chat BOOLEAN NOT NULL DEFAULT false,
  perm_fill_forms BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (file_id, invitee_id)
);

CREATE INDEX IF NOT EXISTS idx_file_shares_invitee ON file_shares (invitee_id);
CREATE INDEX IF NOT EXISTS idx_file_shares_file ON file_shares (file_id);
