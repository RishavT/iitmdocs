-- BigQuery View for Looker Studio
-- Creates a flattened view of conversation logs for easy analytics
--
-- Prerequisites:
--   1. BigQuery dataset 'chatbot_logs' exists (created by cloudbuild.yaml)
--   2. At least one conversation has been logged (creates the source table)
--
-- Usage:
--   Replace YOUR_PROJECT_ID with your GCP project ID, then run:
--   bq query --use_legacy_sql=false < scripts/setup-looker-view.sql
--
-- Or run directly in BigQuery Console

CREATE OR REPLACE VIEW `YOUR_PROJECT_ID.chatbot_logs.conversations` AS
SELECT
  timestamp,
  jsonPayload.session_id AS session_id,
  jsonPayload.conversation_id AS conversation_id,
  JSON_VALUE(TO_JSON_STRING(jsonPayload), '$.username') AS username,
  jsonPayload.question AS question,
  jsonPayload.rewritten_query AS rewritten_query,
  jsonPayload.query_source AS query_source,
  jsonPayload.response AS response,
  CAST(jsonPayload.latency_ms AS INT64) AS latency_ms,
  jsonPayload.fact_check_passed AS fact_check_passed,
  jsonPayload.contains_raahat AS contains_raahat,
  CAST(jsonPayload.history_length AS INT64) AS history_length,
  TO_JSON_STRING(jsonPayload.documents) AS documents,
  -- Derived fields for analytics
  DATE(timestamp) AS date,
  EXTRACT(HOUR FROM timestamp) AS hour,
  CASE
    WHEN CAST(jsonPayload.latency_ms AS INT64) < 2000 THEN 'fast'
    WHEN CAST(jsonPayload.latency_ms AS INT64) < 5000 THEN 'normal'
    ELSE 'slow'
  END AS latency_category
FROM `YOUR_PROJECT_ID.chatbot_logs.run_googleapis_com_stdout_*`
WHERE jsonPayload.message = "conversation_turn";
