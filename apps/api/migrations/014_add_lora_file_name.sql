-- Add file_name for LoRA library (Milestone 7)
ALTER TABLE loras
  ADD COLUMN IF NOT EXISTS file_name TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_loras_file_name ON loras(file_name);
