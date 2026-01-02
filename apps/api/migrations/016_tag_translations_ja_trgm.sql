-- Optional trigram index to accelerate ja ILIKE searches.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION
    WHEN insufficient_privilege OR undefined_file THEN
      NULL;
  END;

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_tag_translations_ja_trgm ON tag_translations USING GIN (ja gin_trgm_ops)';
  END IF;
END $$;
