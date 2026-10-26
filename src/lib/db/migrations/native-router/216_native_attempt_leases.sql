-- A legacy reserved row never entered dispatch. Started work has an unknown
-- outcome, so it must not be replayed or declared free. Preserve known receipts.
ALTER TABLE decision_application_attempts ADD COLUMN lease_owner TEXT;
ALTER TABLE decision_application_attempts ADD COLUMN lease_expires_at INTEGER;
-- Historical combo identities cannot be recovered safely after later renames.
ALTER TABLE decision_application_attempts ADD COLUMN requested_model TEXT;
DROP INDEX IF EXISTS idx_decision_active_key;

UPDATE decision_application_attempts
SET state='cancelled',
    input_tokens=COALESCE(input_tokens,0),
    output_tokens=COALESCE(output_tokens,0),
    cost_usd=COALESCE(cost_usd,0),
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE state='reserved';

UPDATE decision_application_attempts
SET state='unknown',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE state='started';
