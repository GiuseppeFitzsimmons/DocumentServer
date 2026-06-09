CREATE TABLE IF NOT EXISTS file_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  s3_key TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  changes_s3_key TEXT,
  changes_json JSONB,
  document_key TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (file_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_file_versions_file_id ON file_versions (file_id);
