CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS gallery_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  recursive BOOLEAN NOT NULL DEFAULT TRUE,
  include_glob TEXT NULL,
  last_scan_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE gallery_items
  ADD COLUMN IF NOT EXISTS source_id UUID NULL REFERENCES gallery_sources(id) ON DELETE CASCADE;

ALTER TABLE gallery_items
  ADD COLUMN IF NOT EXISTS rel_path TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_gallery_items_unique_folder
  ON gallery_items (source_type, source_id, rel_path);

CREATE INDEX IF NOT EXISTS idx_gallery_sources_enabled ON gallery_sources(enabled);
