CREATE TABLE IF NOT EXISTS user_font_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  font_name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, font_name)
);

CREATE INDEX IF NOT EXISTS idx_user_font_preferences_user_id ON user_font_preferences (user_id);
