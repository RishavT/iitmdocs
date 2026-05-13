-- This file is mounted into the Postgres container at /docker-entrypoint-initdb.d.
-- Note: Docker's init scripts only auto-run on first initialization of the data volume.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS faqs (
  id BIGSERIAL PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  embedding vector(1024)
);
