CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS gallery_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL,
  comfy_run_id UUID NULL REFERENCES comfy_runs(id) ON DELETE CASCADE,
  prompt_id TEXT NULL,
  filename TEXT NOT NULL,
  subfolder TEXT NULL,
  file_type TEXT NULL,
  width INT NULL,
  height INT NULL,
  ckpt_name TEXT NULL,
  lora_names TEXT[] NULL,
  positive TEXT NULL,
  negative TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  favorited BOOLEAN NOT NULL DEFAULT FALSE,
  meta JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gallery_items_unique_source
  ON gallery_items (
    source_type,
    comfy_run_id,
    filename,
    COALESCE(subfolder, ''),
    COALESCE(file_type, '')
  );

CREATE INDEX IF NOT EXISTS idx_gallery_items_created_at ON gallery_items(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gallery_items_ckpt_name ON gallery_items(ckpt_name);
CREATE INDEX IF NOT EXISTS idx_gallery_items_lora_names ON gallery_items USING GIN (lora_names);
CREATE INDEX IF NOT EXISTS idx_gallery_items_favorited ON gallery_items(favorited);
