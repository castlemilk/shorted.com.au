-- Inverse of 000151_add_crawl_finalize_state.up.sql. Drops only the finalize cursor and
-- lease; the ingest tables from 000150 are untouched.
DROP TABLE IF EXISTS crawl_finalize_lease;
DROP TABLE IF EXISTS crawl_finalize_state;
