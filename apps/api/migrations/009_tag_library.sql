CREATE TABLE IF NOT EXISTS tag_dictionary_entries (
  tag text PRIMARY KEY,
  type text NULL,
  count int NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tag_translations (
  tag text PRIMARY KEY,
  ja text NOT NULL,
  source text NOT NULL DEFAULT 'ollama',
  seen_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tag_dictionary_entries_lower_tag
  ON tag_dictionary_entries (lower(tag));

CREATE INDEX IF NOT EXISTS idx_tag_translations_lower_tag
  ON tag_translations (lower(tag));
