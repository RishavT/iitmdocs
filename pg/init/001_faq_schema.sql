-- Step 2: Base schema for FAQ storage (no embeddings yet).
-- This file is mounted into the Postgres container at /docker-entrypoint-initdb.d.
-- Note: Docker's init scripts only auto-run on first initialization of the data volume.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS faqs (
  id BIGSERIAL PRIMARY KEY,
  topic_filename TEXT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  source_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
