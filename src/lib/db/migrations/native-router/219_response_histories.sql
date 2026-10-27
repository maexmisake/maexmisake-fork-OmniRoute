-- Explicitly opted-in encrypted Responses history; ownership remains in routing sessions.
CREATE TABLE decision_response_histories (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  combo_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','ready','unknown')),
  source_attempt_id TEXT,
  binding_json TEXT,
  policy_hash TEXT NOT NULL,
  authority_hash TEXT,
  history_ciphertext TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_decision_responses_owner ON decision_response_histories(api_key_id,combo_id,expires_at);
