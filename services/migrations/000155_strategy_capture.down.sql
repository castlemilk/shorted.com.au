-- Reverses 000155. Drops the vintage trigger and function, then the three tables it created. The
-- vintage history is lost with them, so do not run this against a database whose strategy engine has
-- started reading it. Deploys never run a down file: 000155 is replayed by the up file only.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS trg_fundamentals_vintage ON stock_fundamentals;
DROP FUNCTION IF EXISTS record_fundamentals_vintage();

DROP TABLE IF EXISTS stock_fundamentals_vintages;
DROP TABLE IF EXISTS shorts_revisions;
DROP TABLE IF EXISTS asic_report_ingests;

COMMIT;
