-- Step 2: Base schema for FAQ storage.
-- This file is mounted into the Postgres container at /docker-entrypoint-initdb.d.
-- Note: Docker's init scripts only auto-run on first initialization of the data volume.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS faqs (
  id BIGSERIAL PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  embedding vector(1024)
);

-- TODO: Remove this compatibility ALTER after one successful test-env deployment with the embedding column defined in CREATE TABLE.
ALTER TABLE faqs
ADD COLUMN IF NOT EXISTS embedding vector(1024);

ALTER TABLE faqs
DROP COLUMN IF EXISTS topic_filename,
DROP COLUMN IF EXISTS source_url,
DROP COLUMN IF EXISTS created_at;
