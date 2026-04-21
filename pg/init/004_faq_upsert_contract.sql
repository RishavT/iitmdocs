-- Step: FAQ upsert contract for managed Postgres deployments (GCP Cloud SQL).
--
-- Purpose:
-- - Define what "the same FAQ row" means for upsert.
-- - Ensure embeddings are invalidated automatically when FAQ content changes.
--
-- Current project decision:
-- - Uniqueness is ONLY on `question`.
--   (If duplicate questions exist, this index creation will fail and you must dedupe.)

-- 1) Unique key for upsert
CREATE UNIQUE INDEX IF NOT EXISTS faqs_question_uniq
ON faqs (question);

-- 2) Invalidate derived embeddings when FAQ content changes
CREATE OR REPLACE FUNCTION faqs_null_embedding_on_change()
RETURNS trigger AS $$
BEGIN
  IF (NEW.topic_filename IS DISTINCT FROM OLD.topic_filename)
     OR (NEW.question IS DISTINCT FROM OLD.question)
     OR (NEW.answer IS DISTINCT FROM OLD.answer) THEN
    NEW.embedding := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS faqs_null_embedding_on_change_trg ON faqs;
CREATE TRIGGER faqs_null_embedding_on_change_trg
BEFORE UPDATE ON faqs
FOR EACH ROW
EXECUTE FUNCTION faqs_null_embedding_on_change();

