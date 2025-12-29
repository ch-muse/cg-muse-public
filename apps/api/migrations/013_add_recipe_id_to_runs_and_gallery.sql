-- Add recipe_id linkage for runs and gallery items (Milestone 6)
ALTER TABLE comfy_runs
  ADD COLUMN IF NOT EXISTS recipe_id UUID NULL REFERENCES recipes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_comfy_runs_recipe_id ON comfy_runs(recipe_id);

ALTER TABLE gallery_items
  ADD COLUMN IF NOT EXISTS recipe_id UUID NULL REFERENCES recipes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_gallery_items_recipe_id ON gallery_items(recipe_id);
