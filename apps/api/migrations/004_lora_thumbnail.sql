-- Add thumbnail key to loras for representative image (single thumbnail per LoRA)
ALTER TABLE loras ADD COLUMN IF NOT EXISTS thumbnail_key TEXT NULL;
