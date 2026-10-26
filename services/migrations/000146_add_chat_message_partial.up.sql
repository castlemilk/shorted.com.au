-- Marks the assistant replies a failed chat turn kept, so a retry can tell its
-- own partial reply from a complete one.
--
-- WHY A COLUMN
--
-- A retry used to delete the newest assistant reply whenever the message before
-- it had the same text as the question. A complete answer to a repeated question
-- matched that rule, so Try again could remove a reply the person had already
-- received. The text cannot tell a partial reply from a complete one. The chat
-- service now sets this flag when it keeps a partial reply, and a retry removes
-- only a flagged row.
--
-- IDEMPOTENCY
--
-- Prod replays every allowlisted migration on every deploy
-- (.github/workflows/terraform-deploy.yml). ALTER TABLE takes ACCESS EXCLUSIVE
-- on chat_messages even when IF NOT EXISTS skips the change, so the column is
-- added only when the catalog lacks it. A replay that changes nothing takes no
-- lock on the table, and every chat insert keeps running.
--
-- Existing rows read as complete replies (FALSE). A retry never removes a
-- complete reply, so a partial reply saved before this column keeps its place
-- in the history. The file runs under lock_timeout, as 000136 and 000145 do.

BEGIN;
SET LOCAL lock_timeout = '15s';

DO $m146_partial$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_attribute
        WHERE attrelid = to_regclass('chat_messages')
          AND attname = 'partial'
          AND NOT attisdropped
    ) THEN
        -- IF NOT EXISTS is redundant inside the guard. It is there because
        -- scripts/tests/migration-drift.test.mjs requires it on every allowlisted
        -- ADD COLUMN, and the guard is what keeps the replay from taking a lock.
        ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS partial BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
END
$m146_partial$;

COMMIT;
