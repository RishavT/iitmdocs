-- Step: Remove legacy FAQ upsert/invalidation contract.
--
-- Current project decision:
-- - `pg/seed/faqs.json` is the FAQ source of truth.
-- - FAQ bootstrap clears existing FAQ rows and reloads all seed rows.
-- - Embeddings are regenerated for the newly loaded rows.
--
-- Because of that replace-all flow, we no longer need:
-- - uniqueness on question for upsert conflict handling
-- - a trigger to null embeddings on UPDATE
-- - a topic_filename index for a table with at most a few hundred rows

DROP TRIGGER IF EXISTS faqs_null_embedding_on_change_trg ON faqs;
DROP FUNCTION IF EXISTS faqs_null_embedding_on_change();
DROP INDEX IF EXISTS faqs_question_uniq;
DROP INDEX IF EXISTS faqs_topic_filename_idx;
