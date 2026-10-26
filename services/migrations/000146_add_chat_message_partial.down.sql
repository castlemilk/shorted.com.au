-- Reverting drops the partial-reply mark. Its rows become indistinguishable from
-- complete replies, so a retry of a failed turn stores its question as new
-- instead of replacing the partial reply. Roll back only with the chat service
-- image that predates this column, because the current one selects it.
ALTER TABLE chat_messages DROP COLUMN IF EXISTS partial;
