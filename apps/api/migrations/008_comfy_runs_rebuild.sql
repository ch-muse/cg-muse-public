CREATE EXTENSION IF NOT EXISTS pgcrypto;
DROP TABLE IF EXISTS comfy_runs;
CREATE TABLE IF NOT EXISTS comfy_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL,
  prompt_id TEXT NULL,
  request_json JSONB NOT NULL,
  workflow_json JSONB NOT NULL,
  history_json JSONB NULL,
  error_message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_comfy_runs_updated_at ON comfy_runs(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_comfy_runs_prompt_id ON comfy_runs(prompt_id);
