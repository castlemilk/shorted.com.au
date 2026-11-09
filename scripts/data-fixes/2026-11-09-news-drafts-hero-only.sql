-- One-off data correction, 2026-11-09: two unpublished content/news drafts go out with
-- their hero only, like the seven reviewed 21 October articles, not with the three
-- AI layout images the publish job generated for them.
--
--   dro-us-idiq-ceiling-and-subscriptions, tlx-bipass-fast-track-and-short-baseline
--
-- Both were published with images on because their only art was a borrowed cover.png
-- that failed the publication vision review. The generated heroes passed every review
-- (three each). The layout images did not converge:
--   - each publish-time review flagged a different one;
--   - DroneShield's second rejection judged a stale copy of a regenerated image.
-- Regeneration overwrites takes/<slug>-layout-N.png in place under
-- Cache-Control max-age=86400, so the unchanged URL can serve the old bytes for a day.
-- The 281- and 314-word articles carry their own data graphics (StatGroup,
-- ShortInterestChart).
--
-- Each row is matched on slug, still unpublished, its current hero and three layout
-- images; any mismatch aborts the transaction (task db:prod:apply runs this file in
-- one transaction). Both rows' image fields are backed up in full as JSON (PR #942).
DO $$
DECLARE n int;
BEGIN
  UPDATE editorial_takes t
     SET layout_images = '[]'::jsonb, updated_at = NOW()
    FROM (VALUES
      ('dro-us-idiq-ceiling-and-subscriptions',
       'https://storage.googleapis.com/shorted-company-logos-prod/takes/dro-us-idiq-ceiling-and-subscriptions-hero.png'),
      ('tlx-bipass-fast-track-and-short-baseline',
       'https://storage.googleapis.com/shorted-company-logos-prod/takes/tlx-bipass-fast-track-and-short-baseline-hero.png')
    ) AS v(slug, hero)
   WHERE t.slug = v.slug
     AND t.hero_image_url = v.hero
     AND t.published_at IS NULL
     AND jsonb_array_length(COALESCE(t.layout_images, '[]'::jsonb)) = 3;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 2 THEN
    RAISE EXCEPTION 'expected to clear 2 draft rows, matched %; nothing changed', n;
  END IF;
END $$;
