-- Inverse of 000151_add_crawl_finalize_state.up.sql. Drops only the finalize cursor;
-- the ingest tables from 000150 are untouched.
DROP TABLE IF EXISTS crawl_finalize_state;
