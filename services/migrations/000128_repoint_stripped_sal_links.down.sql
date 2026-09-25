-- 000128 is a data repair: it moved 30 prod suburb regions (and their crawl
-- copies) off a wrong same-named locality. Reversing it would re-create the
-- mislinks, and the old values are not kept anywhere to restore from, so the
-- down migration is deliberately a no-op. The moved rows are listed in the
-- follow-ups report (2026-09-24) if a manual reversal is ever needed.

SELECT 1;
