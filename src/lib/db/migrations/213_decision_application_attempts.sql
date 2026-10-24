-- Metadata only. reserved is an exclusive dispatch slot, never a dollar reservation.
CREATE TABLE IF NOT EXISTS decision_application_attempts (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  combo_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  effort TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved','started','completed','unknown','cancelled')),
  http_status INTEGER,
  application_status INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  reasoning_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  selection_trace TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decision_attempt_key ON decision_application_attempts(api_key_id,state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_active_key ON decision_application_attempts(api_key_id)
  WHERE state IN ('reserved','started');

ALTER TABLE usage_history ADD COLUMN decision_attempt_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_decision_attempt ON usage_history(decision_attempt_id);
