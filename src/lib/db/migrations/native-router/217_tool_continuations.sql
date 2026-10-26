-- Metadata only. No prompts, arguments, tool results or signed thinking are retained.
CREATE TABLE decision_tool_turns (
  id TEXT NOT NULL PRIMARY KEY,
  source_attempt_id TEXT NOT NULL UNIQUE REFERENCES decision_application_attempts(id) ON DELETE CASCADE,
  api_key_id TEXT NOT NULL,
  combo_id TEXT NOT NULL,
  previous_turn_id TEXT REFERENCES decision_tool_turns(id) ON DELETE CASCADE,
  depth INTEGER NOT NULL CHECK(depth BETWEEN 0 AND 31),
  state TEXT NOT NULL CHECK(state IN ('issued','claimed','consumed','unknown')),
  prefix_mac TEXT NOT NULL,
  contract_mac TEXT NOT NULL,
  calls_mac TEXT NOT NULL,
  authority_mac TEXT NOT NULL,
  thinking_mac TEXT,
  claimed_attempt_id TEXT UNIQUE REFERENCES decision_application_attempts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_decision_tool_live ON decision_tool_turns(api_key_id,combo_id,expires_at,state);
CREATE INDEX idx_decision_tool_previous ON decision_tool_turns(previous_turn_id);
CREATE TABLE decision_tool_calls (
  turn_id TEXT NOT NULL REFERENCES decision_tool_turns(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 31),
  id_mac TEXT NOT NULL,
  descriptor_mac TEXT NOT NULL,
  PRIMARY KEY(turn_id,id_mac),
  UNIQUE(turn_id,ordinal)
);
