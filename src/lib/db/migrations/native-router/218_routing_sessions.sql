-- Exact routing metadata only; no task text, transcripts or provider credentials.
CREATE TABLE decision_routing_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  api_key_id TEXT NOT NULL,
  combo_id TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  binding_json TEXT,
  authority_hash TEXT,
  turns INTEGER NOT NULL DEFAULT 0,
  stable_turns INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK(state IN ('idle','claimed','unknown')),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  attempt_id TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_decision_sessions_owner ON decision_routing_sessions(api_key_id,combo_id,expires_at);
