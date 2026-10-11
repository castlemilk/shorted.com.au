-- The parser version that recorded each dividend notice outcome. The
-- announcements job re-reads a notice that failed under an older version, so
-- a parser fix reprocesses its failures. Existing rows were recorded by
-- version 1. Allowlisted and replayed on every deploy: IF NOT EXISTS, no row
-- touched (the DEFAULT fills existing rows without rewriting them).
ALTER TABLE dividend_notice_attempts ADD COLUMN IF NOT EXISTS parser_version INTEGER NOT NULL DEFAULT 1;
