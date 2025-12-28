-- Whisper transcription jobs table
CREATE TABLE IF NOT EXISTS whisper_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL,
  model_file TEXT NOT NULL,
  language TEXT NULL,
  input_original_name TEXT NOT NULL,
  input_path TEXT NOT NULL,
  preprocessed_wav_path TEXT NULL,
  output_text_path TEXT NULL,
  stdout_tail TEXT NULL,
  stderr_tail TEXT NULL,
  pid INT NULL,
  error_message TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whisper_jobs_created_at ON whisper_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_whisper_jobs_status ON whisper_jobs(status);
