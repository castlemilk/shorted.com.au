-- One-off data correction, 2026-11-09: the newsroom draft backlog. 97 unpublished
-- editorial_takes drafts, written 11 June to 10 September 2026 by the newsroom pipeline,
-- covering 35 stocks. The owner chose to publish the newest draft for each stock, each
-- opening with the dated note the content/news articles carry, and to delete the rest.
--
--   34 drafts dated: the newest draft with at least one citation for each stock. Each
--      opens with "> **When this was written** — On <its Sydney creation date>. The
--      figures are as at that date or earlier and have not been updated since."
--   63 drafts deleted: the older drafts of those stocks (near-duplicates), and ATBHQ's only
--      draft, which has no citations (the newsroom never publishes an uncited draft).
--
-- Every row is matched on slug, still unpublished and md5(body_md) as reviewed; a row that
-- changed since is left alone and the count checks abort the whole transaction
-- (task db:prod:apply runs this file in one transaction). All 97 rows are backed up in full
-- as JSON before it runs. editorial_takes has no foreign keys or triggers.
DO $$
DECLARE n int;
BEGIN
  UPDATE editorial_takes t
     SET body_md = '> **When this was written** — On ' || v.written
                   || '. The figures are as at that date or earlier and have not been updated since.'
                   || E'\n\n' || t.body_md,
         updated_at = NOW()
    FROM (VALUES
      ('acl-shorts-build-821-position-as-australian-clinical-labs-rallies', '7f6c933cac0016427dd562e9101afd4c', '19 June 2026'),  -- ACL
      ('ore-orezone-shorts-surge-72pp-as-operational-updates-draw-heavy-bets', 'a615315d41dbcab8ed4bf3231a3486b3', '19 June 2026'),  -- ORE
      ('flt-turner-puts-a1-million-on-the-line-against-flight-centre-shorts', '915ad63903d6dd2536c2a021301a5039', '26 June 2026'),  -- FLT
      ('edv-endeavour-directors-spend-a328k-fighting-a-10-short-position', 'da4eed9ef5bc72df323bf7df73d98873', '29 June 2026'),  -- EDV
      ('bpt-beach-energy-shorts-near-10-as-shares-hit-five-year-low', '88b1f2c08b6ce562e2122f7d1a34506f', '30 June 2026'),  -- BPT
      ('pdn-paladin-shorts-climb-to-114-as-uranium-narrative-cools', 'd4512ffc7f1530c1d66677c5e8c5d244', '30 June 2026'),  -- PDN
      ('dmp-quiet-conviction-keeps-dominos-at-14-short-interest', 'de7f9a24e0966b84be65ccd42e75dc39', '1 July 2026'),  -- DMP
      ('rio-tinto-shorts-climb-to-87-despite-copper-led-rally', '2c5cc97e0d2e5de4d871bb48a0176466', '1 July 2026'),  -- RIO
      ('slx-silex-shorts-rise-above-8-while-shares-drop-43', '438ad53eaade2e35a91841f7cab771bb', '10 July 2026'),  -- SLX
      ('cuv-clinuvel-shorts-hold-91-line-despite-a-double-digit-stock-rally', '27c15628c6846cc1e0f975d30bf86fd5', '13 July 2026'),  -- CUV
      ('dyl-deep-yellow-shorts-hit-87-on-24-price-slide', '2e930006d17073fd03691f7215c3440a', '15 July 2026'),  -- DYL
      ('msb-mesoblast-shorts-hold-tight-through-a-16-price-rally', '9c0a31bcb1c5abb740c55b0caf0e9d53', '15 July 2026'),  -- MSB
      ('twe-shorts-hold-above-10-despite-recent-price-rally', '1104a097ce43e726a92676143dfacb15', '17 July 2026'),  -- TWE
      ('pnv-polynovo-shorts-retreat-31pp-in-a-complete-information-vacuum', '658e983e8d60caaecb076be7f0665d96', '20 July 2026'),  -- PNV
      ('tlx-telix-shorts-retreat-as-behrenbruch-leads-a1m-board-buy', 'e83ce57c709901829c1a7dd8e2b5aebd', '24 July 2026'),  -- TLX
      ('cu6-clarity-shorts-hold-firm-at-82-as-losses-double', '023f47220d7d3c39c66f114c5de2b28e', '27 July 2026'),  -- CU6
      ('eld-elders-shorts-hit-105-as-directors-buy-the-26-dip', 'e860b104392f83c777ec9bd50cd1d53d', '27 July 2026'),  -- ELD
      ('gyg-shorts-capitulate-after-pulling-the-pin-on-america', 'cc7ef9e6033e0f6c3017cacc4412dbdd', '27 July 2026'),  -- GYG
      ('nxt-nextdc-insiders-buy-a375k-to-counter-83-short-position', 'e5c0afdbc08b36b29bd1093e212bad93', '3 August 2026'),  -- NXT
      ('hls-healius-shorts-climb-to-101-despite-27-price-rally', 'c9c386c6a6fe758622d8336fd74b2075', '24 August 2026'),  -- HLS
      ('4dx-shorts-hit-1236-as-directors-spend-a100k-to-fight-back', '3c83359af27e84c06faf1a453d518f9c', '31 August 2026'),  -- 4DX
      ('coh-cochlear-shorts-target-92-as-margin-pressure-shadows-43-rally', '2e07229e2bd20c3e44596af14cedba34', '31 August 2026'),  -- COH
      ('eos-shorts-hit-88-despite-a-a183k-board-buying-spree', 'f5724e9a3f89503ba8d24a52f502eac2', '31 August 2026'),  -- EOS
      ('boe-boss-energy-shorts-flee-as-honeymoon-milestones-trigger-21-surge', '81e89b61f443ffca6ef42d3cbd11ccc5', '1 September 2026'),  -- BOE
      ('gmd-genesis-shorts-climb-to-938-as-insiders-fight-the-rally', '7e2bcb46bce90604012f475902d087b2', '1 September 2026'),  -- GMD
      ('pls-pilbara-minerals-shorts-hit-1122-as-directors-trade-places', '52fe6611792ca005717080dd1affa322', '1 September 2026'),  -- PLS
      ('a4n-alpha-hpa-shorts-hit-816-peak-as-gladstone-developer-slides', '2cb01b729d0c9fe2337548138d152cb3', '2 September 2026'),  -- A4N
      ('bap-mufg-buying-squeezes-bapcor-shorts-during-21-rally', 'd4d0fdd646a173f7e9b17476b5477d5c', '2 September 2026'),  -- BAP
      ('car-group-shorts-climb-to-12-despite-onplatinum-divestment', '811e5ba7896cd89386331d71fd2deef8', '2 September 2026'),  -- CAR
      ('wtc-wisetech-shorts-hit-88-as-price-rally-defies-founder-fallout', 'ffad1395ba8af0253dc4867b0070b6d9', '2 September 2026'),  -- WTC
      ('dro-droneshield-shorts-reach-15-during-38-market-correction', 'bfe1c3d7ccce9780ebdae8ff8c15c756', '11 September 2026'),  -- DRO
      ('ipx-iperionx-directors-spend-a197m-to-fight-a-1076-short-position', '692d7b6dd6398836082dacbafb3eb01f', '11 September 2026'),  -- IPX
      ('lot-lotus-shorts-retreat-8pp-from-peak-as-board-buys', '2c8aed19b6b266105cba7ff13fdadf07', '11 September 2026'),  -- LOT
      ('zip-shorts-creep-to-117-while-directors-cash-out', '8e3f07bd8e501d1b80a54fb9113e74f9', '11 September 2026')  -- ZIP
    ) AS v(slug, body_md5, written)
   WHERE t.slug = v.slug AND t.published_at IS NULL AND md5(t.body_md) = v.body_md5;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 34 THEN
    RAISE EXCEPTION 'expected to date 34 drafts, matched %; nothing changed', n;
  END IF;

  DELETE FROM editorial_takes t
   USING (VALUES
      ('car-group-shorts-hit-11-as-annual-chart-sheds-27', '18f1cd3dc474b12867f446ff6b4209c3'),  -- CAR
      ('boe-boss-energy-shorts-surge-as-honeymoon-costs-double-on-rain', '7bceef3fb9480140547090d0ac4f7b44'),  -- BOE
      ('gyg-shorts-hold-near-126-after-asx-200-exit', '213ff25658194cd912f68a45d0972efe'),  -- GYG
      ('twe-treasury-wine-shorts-hold-at-12-despite-a-23-price-rally', '52c9bd92676a6d7d3c065d48b84dd05c'),  -- TWE
      ('eld-elders-shorts-hit-95-on-delta-ag-integration-drag', 'bd3aed5cf5f414b3f48e6709c89d54d0'),  -- ELD
      ('lot-lotus-shorts-hit-228-on-widening-losses-and-kayelekera-fire', '4095626e1a1ffe75bf10eb86689ae356'),  -- LOT
      ('pls-shorts-hit-102-despite-a-39-share-price-rally', '790c1f4332d6dd3bc19ffbcdd10e0083'),  -- PLS
      ('edv-endeavour-short-interest-hits-103-as-strategy-reset-stumbles', '496f1dd2ac8aab71f452d7a87adec6bf'),  -- EDV
      ('pnv-polynovo-shorts-capitulate-as-profit-surges-151', '3dcd0a6386481e26a737cb407fb5d894'),  -- PNV
      ('tlx-telix-shorts-trapped-by-a-21-three-month-climb', 'f0e5feb6126e753e3123b1e5b8f7c988'),  -- TLX
      ('4dx-4dmedical-shorts-reach-11-as-losses-balloon-to-153m', '69e9f0e3b3f56a5ae46ba8be2d3b57b0'),  -- 4DX
      ('eld-elders-shorts-climb-to-898-as-board-buys-the-slide', '4d3de2e56e957abe56fea689f9f57f7c'),  -- ELD
      ('lot-lotus-shorts-hit-23-as-kayelekera-restart-faces-delays', '2b3303b85aedb7e4a06383932c54f407'),  -- LOT
      ('car-group-shorts-surged-to-122-despite-a-5-price-gain', 'a18e16babce288bd0a0f09f119110e2a'),  -- CAR
      ('coh-cochlear-shorts-hit-888-after-guidance-reset', '2a55c0b37252619bb5ca2de3a284fb09'),  -- COH
      ('hls-healius-short-position-hits-108-as-pathology-margins-bleed', '15fda7b8a130f6497e84a4223f6f6b88'),  -- HLS
      ('wtc-directors-buy-a521k-of-wisetech-as-shorts-hit-836', '91b7bd69f3612fa05d0b099b8ff64906'),  -- WTC
      ('dro-droneshield-shorts-hit-12-as-regulatory-probe-triggers-40-collapse', '91d34bc083291a687f66a0eaabb94354'),  -- DRO
      ('gyg-guzman-y-gomez-shorts-retreat-as-us-exit-fuels-23-rally', '6d9c5f04ffda41d2825742841a10521c'),  -- GYG
      ('msb-mesoblast-shorts-hold-at-825-as-cash-burn-hits-us30m', 'e4c8c687d72198746a1b67dac2f5a2e6'),  -- MSB
      ('dyl-deep-yellow-shorts-reach-878-as-the-tumas-premium-fades', '2447cf67a37607eb336569f403324683'),  -- DYL
      ('pnv-short-sellers-flee-pnv-as-director-buys-the-dip', 'dd09bea9f9d0d768b6f283c7230933e9'),  -- PNV
      ('eld-elders-directors-spend-a193000-as-shorts-reach-92', '74be6a545db97a4c07d2144efbe3643c'),  -- ELD
      ('ipx-directors-buy-a257m-of-iperionx-to-counter-9-short', '430467a82c427b69f6b346df17540b27'),  -- IPX
      ('lot-lotus-short-interest-hits-228-as-kayelekera-stalls', 'a77c354203f0b4945eaac4aa7ea3eef9'),  -- LOT
      ('tlx-telix-shorts-retreat-as-insider-buying-fuels-29-rally', '40af3a37794639c02daac524b8eaaf0b'),  -- TLX
      ('zip-shorts-hold-at-96-despite-a-117-rally', '67b6561b8e6f7a82f98c10f17e0bacea'),  -- ZIP
      ('4dx-4dmedical-shorts-reach-116-as-insider-buying-fails-to-stem-slide', '1b4e061db40adfe26bf2d6934efa0449'),  -- 4DX
      ('car-group-shorts-climb-to-114-against-a-14-rally', '0365c28a1e6c2ddac77264b1079781a4'),  -- CAR
      ('coh-cochlear-shorts-climb-to-92-as-premium-valuation-cracks', '73098c8291de52f866378947f9e0763e'),  -- COH
      ('gyg-shorts-down-26pp-as-36-rally-squeezes-skeptics', 'c893d1ec349e8f6189d85f792e2df5b1'),  -- GYG
      ('hls-healius-short-interest-touches-10-as-turnaround-timeline-slips', 'a9b51966757072ede85d0d6095634b00'),  -- HLS
      ('twe-shorts-hold-at-11-despite-recent-18-share-rally', '1e9d9f9100d167e3cf49f3870e63f757'),  -- TWE
      ('pnv-polynovo-shorts-cover-as-h1-revenue-hits-a75m', 'bcbf3785fdddcdf94cf30d2e7acb0d63'),  -- PNV
      ('atbhq-trapped-in-purgatory-with-a-100-short-on-atbhq', '0072edc8af4f7a15d0a519efd750eb46'),  -- ATBHQ
      ('eld-elders-shorts-hit-103-as-directors-chase-a-26-slide', 'fa5c41d5dff16e0f574a8ac14f957fdb'),  -- ELD
      ('lot-lotus-shorts-hit-228-ahead-of-kayelekera-uranium-restart', 'b9c3a2dd5315f959d461f85cf7fa4747'),  -- LOT
      ('tlx-telix-shorts-retreat-as-behrenbruch-leads-a1m-buying-spree', 'f0d507377e376e711d0a9f0bf77b9339'),  -- TLX
      ('ipx-iperionx-shorts-climb-to-967-despite-a44m-director-buying', '651a892da2b1593c3b58af9b5ab08ef0'),  -- IPX
      ('4dx-4dmedical-shorts-double-to-11-as-directors-buy-the-collapse', 'bf664dc0b87b2fef65140861b5a33f5b'),  -- 4DX
      ('car-group-shorts-hit-115-despite-9-share-rally', '532352956dcb44e3a837414de3358938'),  -- CAR
      ('coh-cochlear-shorts-climb-to-987-as-price-slides-28', 'd52cbc03c66205d6610bd1d599259e5f'),  -- COH
      ('gyg-guzman-y-gomez-shorts-retreat-as-us-exit-lifts-price', '16a7b0ddb29d30da3e9b7b654b24dd55'),  -- GYG
      ('zip-shorts-flee-81-rally-as-directors-sell-down', '37f39a0c9f43bb478f84e78d88d39830'),  -- ZIP
      ('4dx-4dmedical-shorts-hit-133-as-shares-slide-39', '601b7c7e6a03411847f1633026e7c247'),  -- 4DX
      ('coh-cochlear-shorts-near-10-as-the-premium-valuation-unravels', 'e3bf72a992fa02a7f4401d7cb6b80669'),  -- COH
      ('ipx-hannigan-spends-a45m-fighting-ipx-shorts-as-stock-slides-20', '88f66dadf7b7fceed6882e17944f4598'),  -- IPX
      ('lot-lotus-shorts-hit-228-as-kayelekera-setbacks-freeze-trading', '2b84c1c0f72f35e63c34392ac1dbd4e4'),  -- LOT
      ('gmd-genesis-minerals-shorts-climb-to-86-on-vault-consolidation-doubts', 'e99b1cf45f10e7445dc77fd9d83c3271'),  -- GMD
      ('4dx-insiders-mount-a100k-defence-as-4dx-shorts-hit-13', '06a353afb862ca9acd259a13f4001b9c'),  -- 4DX
      ('coh-cochlear-short-interest-climbs-to-95-despite-33-price-surge', '1e4036c986d4982a845f3e02b4781dbf'),  -- COH
      ('lot-lotus-short-sellers-dig-in-at-22-after-price-collapse', '6db06c9c4e338f4798a05b3ceae12095'),  -- LOT
      ('4dx-4dmedical-shorts-reach-124-despite-a-directors-a100000-buy', '27e704c59b7e55c00b638b79bcc39b1d'),  -- 4DX
      ('coh-cochlear-shorts-hit-9-despite-a-47-share-price-rally', '55fc58c0b115094dc81ef6e8261972b1'),  -- COH
      ('dro-droneshield-shorts-hold-at-15-despite-dip-buying-rush', 'c143da5872666f80f34213b097439cdd'),  -- DRO
      ('lot-lotus-shorts-sit-at-17-after-a-60-price-crash', 'e10adaa3ba331a62a1c6653917193b08'),  -- LOT
      ('pls-pilbara-shorts-climb-past-10-as-ceo-divests-a4m', '34444d244fe6f678240aa1bb9db32883'),  -- PLS
      ('boe-boss-energy-shorts-retreat-as-a-classic-short-covering-rally-drives-21-gain', '58621bf787d555dd468f9d26a6fa750f'),  -- BOE
      ('gmd-genesis-minerals-shorts-touch-10-as-share-price-surges-32', '3229389c039d4551d732677decf1ad9a'),  -- GMD
      ('zip-shorts-covered-21pp-during-17-rally-while-directors-sold', 'b7e343f3e7b4b8dd0951edcd2822644f'),  -- ZIP
      ('dro-droneshield-shorts-hit-149-as-shares-drop-45', 'ac8f60cb313cb453f67b6fad54c6040a'),  -- DRO
      ('lot-lotus-shorts-shed-10-percentage-points-as-price-plunges', '9ab3526c2e66209f113c8d70eac5b21f'),  -- LOT
      ('ipx-iperionx-shorts-hit-10-as-directors-buy-the-41-dip', '47a857f79120f35cda49a9734dfb373c')  -- IPX
    ) AS v(slug, body_md5)
   WHERE t.slug = v.slug AND t.published_at IS NULL AND md5(t.body_md) = v.body_md5;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 63 THEN
    RAISE EXCEPTION 'expected to delete 63 drafts, matched %; nothing changed', n;
  END IF;
END $$;
