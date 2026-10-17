-- Dividend notices.
--
-- dividend_history used to be filled from announcement HEADLINES, and ASX titles
-- every Appendix 3A.1 notice "Dividend/Distribution - CBA" with no amount, so it
-- stayed empty. The announcements job now parses each notice's PDF.
--
-- record_date        2A.4 of the notice.
-- period_end         2A.3: the reporting or payment period the dividend relates to.
-- declared_currency  2A.8: the currency the dividend was declared in. A non-AUD
--                    dividend's amount_per_share is the company's own stated AUD
--                    equivalent (2A.9a), never a converted guess.
-- declared_amount    The part's amount in declared_currency.
-- announcement_url   The notice it was read from. NULL on rows from the headline
--                    parser, whose ex_date is the announcement date; the API
--                    serves only rows that have one.
-- announced_on       1.5: lets a later update notice replace an earlier one's
--                    values, never the reverse.
--
-- dividend_notice_attempts records each notice's outcome, so a notice is
-- downloaded once (a notice whose text could not be read is retried after 7
-- days).
--
-- Allowlisted in terraform-deploy.yml, so the deploy applies it before the image
-- swap and REPLAYS it on every deploy: IF NOT EXISTS throughout, no row touched.
-- One ALTER TABLE, so a replay takes dividend_history's lock once.

ALTER TABLE dividend_history
    ADD COLUMN IF NOT EXISTS record_date       DATE,
    ADD COLUMN IF NOT EXISTS period_end        DATE,
    ADD COLUMN IF NOT EXISTS declared_currency VARCHAR(3),
    ADD COLUMN IF NOT EXISTS declared_amount   NUMERIC(18, 8),
    ADD COLUMN IF NOT EXISTS announcement_url  TEXT,
    ADD COLUMN IF NOT EXISTS announced_on      DATE;

CREATE INDEX IF NOT EXISTS idx_dividend_history_announcement_url ON dividend_history (announcement_url);

CREATE TABLE IF NOT EXISTS dividend_notice_attempts (
    announcement_url TEXT PRIMARY KEY,
    stock_code       VARCHAR(10) NOT NULL,
    outcome          VARCHAR(40) NOT NULL,
    detail           TEXT,
    attempted_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
