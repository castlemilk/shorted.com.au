BEGIN;

DROP VIEW IF EXISTS v_fund_holdings_latest;
DROP VIEW IF EXISTS v_substantial_holdings_current;
DROP TABLE IF EXISTS fund_holdings;
DROP TABLE IF EXISTS fund_holding_snapshots;
DROP TABLE IF EXISTS security_identifiers;
DROP TABLE IF EXISTS ownership_funds;
DROP INDEX IF EXISTS idx_asx_ann_substantial;
DROP TABLE IF EXISTS substantial_holder_notice_attempts;
DROP TABLE IF EXISTS substantial_holder_notices;
DROP TABLE IF EXISTS ownership_institutions;

COMMIT;
