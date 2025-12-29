-- Milestone 8: Prompt Composer tables + tag dictionary extensions

ALTER TABLE tag_dictionary_entries
  ADD COLUMN IF NOT EXISTS tag_type INT NULL,
  ADD COLUMN IF NOT EXISTS post_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ja TEXT NULL;

ALTER TABLE tag_dictionary_entries
  ALTER COLUMN aliases DROP DEFAULT;

ALTER TABLE tag_dictionary_entries
  ALTER COLUMN aliases TYPE JSONB
  USING COALESCE(to_jsonb(aliases), '[]'::JSONB);

ALTER TABLE tag_dictionary_entries
  ALTER COLUMN aliases SET DEFAULT '[]'::JSONB;

CREATE TABLE IF NOT EXISTS prompt_tag_groups (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  filter JSONB NOT NULL DEFAULT '{"tag_type":[4]}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prompt_tag_group_overrides (
  tag TEXT PRIMARY KEY REFERENCES tag_dictionary_entries(tag),
  group_id INT NOT NULL REFERENCES prompt_tag_groups(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prompt_conflict_rules (
  id SERIAL PRIMARY KEY,
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warn',
  message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prompt_templates (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  target TEXT NOT NULL,
  tokens JSONB NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
