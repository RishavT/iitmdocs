-- This file is mounted into the Postgres container at /docker-entrypoint-initdb.d.
-- Note: Docker's init scripts only auto-run on first initialization of the data volume.

CREATE EXTENSION IF NOT EXISTS vector;

-- TEMPORARY TEST-ENV RESET:
-- The test database may already contain an older `faqs` table without
-- `program_id`. The 4-program FAQ bootstrap replaces rows from `pg/seed`, so
-- this reset is safe only when the deployed seed files are the source of truth.
-- Remove this DROP after the test database has been migrated/reset once.
DROP TABLE IF EXISTS faqs;

CREATE TABLE IF NOT EXISTS faqs (
  id BIGSERIAL PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  embedding vector(1024)
);
