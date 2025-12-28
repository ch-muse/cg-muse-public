-- Workshop tables: LoRA library and Recipes (W1, thumbnails deferred)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS loras (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  trigger_words TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  recommended_weight_min REAL NULL,
  recommended_weight_max REAL NULL,
  notes TEXT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  example_prompts TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NULL,
  source_idea_id UUID NULL REFERENCES ideas(id) ON DELETE SET NULL,
  target TEXT NOT NULL,
  prompt_blocks JSONB NOT NULL,
  variables JSONB NOT NULL DEFAULT '{}'::JSONB,
  tags TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS recipe_loras (
  recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  lora_id UUID NOT NULL REFERENCES loras(id) ON DELETE CASCADE,
  weight REAL NULL,
  usage_notes TEXT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (recipe_id, lora_id)
);

CREATE INDEX IF NOT EXISTS idx_loras_name ON loras(name);
CREATE INDEX IF NOT EXISTS idx_recipes_created_at ON recipes(created_at);
CREATE INDEX IF NOT EXISTS idx_recipe_loras_recipe_id ON recipe_loras(recipe_id);
CREATE INDEX IF NOT EXISTS idx_recipe_loras_lora_id ON recipe_loras(lora_id);
