ALTER TABLE gallery_items
  ADD COLUMN IF NOT EXISTS manual_ckpt_name TEXT NULL,
  ADD COLUMN IF NOT EXISTS manual_lora_names TEXT[] NULL,
  ADD COLUMN IF NOT EXISTS manual_positive TEXT NULL,
  ADD COLUMN IF NOT EXISTS manual_negative TEXT NULL,
  ADD COLUMN IF NOT EXISTS manual_width INT NULL,
  ADD COLUMN IF NOT EXISTS manual_height INT NULL,
  ADD COLUMN IF NOT EXISTS manual_tags TEXT[] NULL,
  ADD COLUMN IF NOT EXISTS manual_notes TEXT NULL,
  ADD COLUMN IF NOT EXISTS meta_extracted JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS meta_overrides JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_gallery_items_manual_ckpt_name ON gallery_items(manual_ckpt_name);
CREATE INDEX IF NOT EXISTS idx_gallery_items_manual_lora_names ON gallery_items USING GIN (manual_lora_names);
CREATE INDEX IF NOT EXISTS idx_gallery_items_manual_tags ON gallery_items USING GIN (manual_tags);
