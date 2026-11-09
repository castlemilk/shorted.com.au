-- One-off data correction, 2026-11-09: the nine content/news articles published earlier on
-- 9 November (written 4 and 21 October) keep the top of /news after the newsroom backlog.
--
-- /news leads with the most recently published take, and its story stack shows one take per
-- stock, the most recent. The 34 dated backlog drafts (written June to September) were
-- published after these nine. A September take would have led the page, and for DRO, TLX,
-- WTC, PLS, NXT, DMP, EDV and TWE the older backlog take would have displaced the fresher
-- October article. This moves the nine forward in their original order, a second apart.
-- They are not backdated; each keeps its 9 November date. The market-wide deep dive is
-- last, so it leads.
--
-- Each row is matched on slug and its exact current published_at; any mismatch aborts the
-- transaction (task db:prod:apply runs this file in one transaction). The previous times
-- are the VALUES below.
DO $$
DECLARE n int;
BEGIN
  UPDATE editorial_takes t
     SET published_at = now() + make_interval(secs => v.ord), updated_at = now()
    FROM (VALUES
      ('dro-us-idiq-ceiling-and-subscriptions', timestamptz '2026-11-09 03:15:35.077082+00', 1),
      ('tlx-bipass-fast-track-and-short-baseline', timestamptz '2026-11-09 03:19:29.06194+00', 2),
      ('aya-shorts-tenfold-since-july-price-halves', timestamptz '2026-11-09 04:42:10.861633+00', 3),
      ('crowded-exits-dmp-twe-edv-days-to-cover', timestamptz '2026-11-09 04:46:20.923597+00', 4),
      ('lithium-shorts-build-pls-ltr-cxo-price-slump', timestamptz '2026-11-09 04:50:12.546694+00', 5),
      ('wtc-record-short-meets-asic-no-action', timestamptz '2026-11-09 04:54:03.711392+00', 6),
      ('nxt-shorts-8pc-into-40pc-fall-jemena-m3-delay', timestamptz '2026-11-09 04:57:55.828292+00', 7),
      ('australia-fuel-security-33-days-diesel-hormuz-october-2026', timestamptz '2026-11-09 05:01:46.886265+00', 8),
      ('asx-shorts-broaden-downtrend-rba-october-2026', timestamptz '2026-11-09 05:05:40.503795+00', 9)
    ) AS v(slug, was, ord)
   WHERE t.slug = v.slug AND t.published_at = v.was;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 9 THEN
    RAISE EXCEPTION 'expected to move 9 published articles, matched %; nothing changed', n;
  END IF;
END $$;
