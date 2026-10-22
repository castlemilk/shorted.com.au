-- Back to the global autovacuum thresholds.
BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.shorts RESET (
    autovacuum_vacuum_insert_threshold, autovacuum_vacuum_insert_scale_factor,
    autovacuum_analyze_threshold, autovacuum_analyze_scale_factor);
ALTER TABLE public.news_articles RESET (
    autovacuum_vacuum_scale_factor, autovacuum_vacuum_insert_scale_factor,
    autovacuum_analyze_scale_factor);
ALTER TABLE public.asx_announcements RESET (
    autovacuum_vacuum_insert_scale_factor, autovacuum_analyze_scale_factor);

COMMIT;
