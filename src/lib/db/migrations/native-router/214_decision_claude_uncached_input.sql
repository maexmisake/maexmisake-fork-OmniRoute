-- Preserve the reported uncached component when a missing cache count makes
-- the aggregate Messages input unknown. No prompt or response content is stored.
ALTER TABLE decision_application_attempts ADD COLUMN uncached_input_tokens INTEGER;
