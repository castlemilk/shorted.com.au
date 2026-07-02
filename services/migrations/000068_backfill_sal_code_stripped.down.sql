-- No-op: a name-match backfill isn't cleanly reversible (we can't tell which
-- sal_code links this migration added vs 000056's exact match). Leave links in place.
SELECT 1;
