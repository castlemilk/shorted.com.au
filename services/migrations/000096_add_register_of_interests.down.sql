-- Reverse 000096_add_register_of_interests.
--
-- Drop order is child -> parent. The FK chain is
--   register_documents -> register_extractions -> register_statements
--                      -> register_declared_items -> {securities, locations}
--   politicians -> {politician_aliases, politician_terms, register_holding_periods}
-- but every FK is ON DELETE CASCADE / SET NULL, so explicit ordering plus
-- IF EXISTS is enough and stays idempotent.

DROP FUNCTION IF EXISTS refresh_register_materialized_views();

DROP VIEW IF EXISTS register_extraction_stats;
DROP VIEW IF EXISTS register_location_backlog;
DROP VIEW IF EXISTS register_resolution_backlog;
DROP VIEW IF EXISTS register_resolution_stats;

DROP MATERIALIZED VIEW IF EXISTS mv_register_suburb_property;
DROP MATERIALIZED VIEW IF EXISTS mv_register_public_holdings;

DROP TABLE IF EXISTS register_holding_periods;
DROP TABLE IF EXISTS register_item_locations;
DROP TABLE IF EXISTS register_item_securities;
DROP TABLE IF EXISTS register_security_aliases;
DROP TABLE IF EXISTS register_declared_items;
DROP TABLE IF EXISTS register_statements;
DROP TABLE IF EXISTS register_extractions;
DROP TABLE IF EXISTS register_documents;
DROP TABLE IF EXISTS politician_terms;
DROP TABLE IF EXISTS politician_aliases;
DROP TABLE IF EXISTS politicians;

DELETE FROM industry_intelligence_sources
 WHERE source_key = 'aph-register-of-interests';
