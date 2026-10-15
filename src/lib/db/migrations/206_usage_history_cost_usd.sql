-- NULL keeps historical token-priced usage distinct from a recorded free request.
ALTER TABLE usage_history ADD COLUMN cost_usd REAL CHECK (cost_usd >= 0);
