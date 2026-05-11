-- This file is mounted into the Postgres container at /docker-entrypoint-initdb.d.
-- Note: Docker's init scripts only auto-run on first initialization of the data volume.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS faqs (
  id BIGSERIAL PRIMARY KEY,
  program_id TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  embedding vector(1024),
  CONSTRAINT faqs_program_question_unique UNIQUE (program_id, question)
);

CREATE INDEX IF NOT EXISTS idx_faqs_program_id ON faqs(program_id);
