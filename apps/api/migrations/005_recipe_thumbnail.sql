-- Add thumbnail key to recipes for representative image
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS thumbnail_key TEXT NULL;