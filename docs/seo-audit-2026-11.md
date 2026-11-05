# SEO Audit — November 2026 (strategy pages: baseline before the anonymous top-10 switch)

**Follows:** `docs/seo-audit-2026-10.md`.

The anonymous top-10 switch (`STRATEGY_PUBLIC_SIGNALS_LIMIT = 10`) cuts the strategy Overview's shortlist from 40 rows
to 10 and its ItemList from 15 to 10. Each page keeps its strategy panel (method, rules, caveats, sources), the evidence
card and its JSON-LD. This section records the Search Console baseline for those pages before the switch, so its
effect can be measured afterwards.

## 1. Baseline (28 days before the switch)

Source: the OpenSEO instance's Search Console data for `sc-domain:shorted.com.au`. Web search, grouped by page. The
window is 2026-10-05 to 2026-11-02 in Pacific time; Search Console's last three days were not yet in. Read on
2026-11-06.

The pages moved on 2026-11-05 from `/picks` to `/strategies`, with permanent (308) redirects. The baseline therefore
covers the `/picks` URLs, and the `/strategies` URLs had no rows yet.

| Page (before the move) | Clicks | Impressions | CTR | Avg position |
|---|---:|---:|---:|---:|
| `/picks/zanger-breakout` | 2 | 73 | 2.7% | 5.1 |
| `/picks/minervini-trend-template` | 0 | 44 | 0% | 5.8 |
| `/picks/quality-compounders` | 0 | 42 | 0% | 4.8 |
| `/picks` (hub) | 0 | 36 | 0% | 11.0 |
| `/picks/crowded-short-breakout` | 0 | 19 | 0% | 6.8 |
| `/picks/canslim` | 0 | 13 | 0% | 13.2 |
| **Total** | **2** | **227** | 0.9% | |

- **Three months** (2026-08-02 to 2026-11-02): 4 clicks and 310 impressions across the same six pages. Quality
  Compounders had the most impressions (73), at position 4.7.
- **Queries:** one query carries real volume: "dan zanger volume breakout", which lands on `/picks/zanger-breakout`
  (19 impressions, position 5.3). Every other query had one or two impressions.
- **Daily:** impressions ran at 0 to 10 a day through most of October, then 12 to 34 a day from 26 to 30 October, and
  3 to 6 a day from 31 October to 2 November.
- **Device split:** desktop 19 impressions (position 10.9), mobile 7 (position 15.7). Search Console totals these
  per property rather than per page, so they do not add up to the page totals above.

## 2. What to compare after the switch

- Compare impressions and average position for the hub and the five strategy pages over the 28 days after the
  switch merges. Search Console consolidates the redirected `/picks` URLs onto `/strategies` over a few weeks, so add
  any remaining `/picks` rows to the `/strategies` figures.
- The volume is small: 227 impressions and 2 clicks in 28 days. A change of under about 30 impressions, or under a
  position, is within the noise of these pages.
- Expected effect: impressions should hold, because the parts of the page that rank (the strategy method, the rules,
  the JSON-LD) are unchanged. The shortlist was rows of tickers, and its cut removes repeated table text rather than
  the copy the queries above match.
