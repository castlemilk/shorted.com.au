-- Reverse 000105_add_aec_donations.
--
-- Nothing in the register-of-interests subsystem is touched on the way down,
-- exactly as nothing was on the way up.

DROP FUNCTION IF EXISTS refresh_aec_donations_materialized_views();

DROP TRIGGER IF EXISTS aec_mp_returns_unlink_resets_method ON aec_mp_returns;
DROP TRIGGER IF EXISTS aec_candidate_returns_unlink_resets_method ON aec_candidate_returns;
DROP FUNCTION IF EXISTS aec_reset_resolution_on_unlink();

DROP FUNCTION IF EXISTS aec_party_contradicts(TEXT, TEXT);
DROP FUNCTION IF EXISTS aec_party_family(TEXT);
DROP FUNCTION IF EXISTS aec_given_names_agree(TEXT, TEXT);

DROP MATERIALIZED VIEW IF EXISTS mv_aec_party_funding;

DROP VIEW IF EXISTS v_aec_party_group_names;
DROP VIEW IF EXISTS v_aec_company_name_matches;

DROP TABLE IF EXISTS aec_refresh_log;
DROP TABLE IF EXISTS aec_candidate_donations;
DROP TABLE IF EXISTS aec_candidate_returns;
DROP TABLE IF EXISTS aec_mp_returns;
DROP TABLE IF EXISTS aec_donations_made;
DROP TABLE IF EXISTS aec_receipts;
DROP TABLE IF EXISTS aec_party_returns;
DROP TABLE IF EXISTS aec_entity_aliases;
