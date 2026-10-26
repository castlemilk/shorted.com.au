-- Reverting drops the past-due start. Every past_due row then has no grace, so
-- roll back only the API image that predates the column, because the current one
-- selects it.
ALTER TABLE api_subscriptions DROP COLUMN IF EXISTS past_due_since;
