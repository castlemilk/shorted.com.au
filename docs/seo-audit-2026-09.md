# SEO Audit — September 2026 (first-party data, OpenSEO crawl, and what shipped)

**Follows:** `docs/seo-audit-2026-08.md` (crawl + competitor re-assessment) and
`docs/seo-strategy-2026-07.md` (the strategy). This round is the first with
**first-party data**: the OpenSEO instance at `seo.benebsworth.com` now has the
Search Console property and the GA4 property connected, so what follows is
measured from our own impressions, clicks and sessions rather than inferred
from US-localised SERPs. DataForSEO is still not keyed on that instance, so
volumes, backlinks and live SERPs remain unavailable (both calls returned 401);
the July/August caveat on "authority is the constraint" therefore still cannot
be measured directly.

Dates: Search Console windows end 2026-09-21 (three-day lag); GA4 windows end
2026-09-23; the crawl ran 2026-09-24 against the Vercel origin
(`shorted-com-au.vercel.app`, 300 pages) because `shorted.com.au` still
challenges every non-browser client (403, Super Bot Fight Mode — unchanged
since August, and still not a Googlebot problem).

---

## 1. Where the traffic actually is

Three months of Search Console (2026-06-21 → 09-21), top pages by clicks:

| Page | Clicks | Impressions | CTR | Avg position |
|---|---|---|---|---|
| `/` | 335 | 22,652 | 1.5% | 6.8 |
| `/shorts/4DX` | 219 | 6,012 | 3.6% | 3.4 |
| `/shorts/ZIP` | 92 | 2,241 | 4.1% | 4.3 |
| `/shorts/DRO` | 90 | 8,494 | 1.1% | 4.0 |
| `/shorts/LOT` | 53 | 3,800 | 1.4% | 6.3 |
| `/shorts/TLX` | 34 | 2,401 | 1.4% | 4.8 |
| `/blog/most-shorted-asx-stocks` | 15 | 1,187 | 1.3% | 6.5 |
| `/top` | 14 | 2,397 | 0.6% | 13.5 |

GA4 organic, last 28 days (08-27 → 09-23): **1,125 sessions, 619 active users**,
down 4.8% on the previous 28 days; engagement rate 66% (down from 75%).

The per-ticker cluster the July plan targeted is now the site's engine: the
top ten click pages are the homepage plus nine stock pages, all ranking in the
top 7. That validates the title retarget again. Two things the numbers add:

- **The head terms are the homepage's, not `/top`'s.** "asx most shorted
  stocks" earned 721 impressions for `/top` at position 10 and **zero clicks**;
  the same query family lands on `/` at position 7–8. July §4.1's "upgrade
  `/top` in place" has not moved it; the homepage is the ranking asset and
  `siteConfig` already says so. Do not split them further.
- **CTR at positions 3–7 is 1–4%**, well under the 8–15% a page-one organic
  result normally earns. `/shorts/DRO` at position 4.0 converts 8,494
  impressions into 90 clicks. The most likely cause is the query mix: many
  impressions are for `dro asx` / `droneshield share price`, where a searcher
  wants a price, not a short position, and the AI overview answers the rest.
  This is a presentation ceiling, not a ranking one.

Impressions grew from roughly 500/day in June to 2,000–4,700/day in
August–September as the housing and politician corpora were indexed; clicks
roughly doubled (12–18/day → 25–40/day). Average position worsened as a
result — thousands of new long-tail rankings at 40–70 — which is expected and
is the raw material for §3.

## 2. Two defects the first-party data exposed

Neither was visible in the August crawl.

### `/industry/not-applic` — a placeholder sector, crawled, then canonicalised to a gambling site

URL inspection: **"Excluded by noindex"** (good, the August soft-404 noindex
works) but `googleCanonical: https://www.747live.bet/`, referring URLs
`/industry/banks` and `/shorts/GCI`. Google decided our empty "Not Applic"
shell was a duplicate of a spam page. The noindex protects the index; the
links were still spending crawl on it. Root cause: `related-stocks.tsx`
linked "View all stocks in this industry" for whatever industry string the
feed carried, including `Not Applic` / `Class Pend`.

**Fixed:** `PLACEHOLDER_INDUSTRY_SLUGS` in `related-stocks.tsx`; the link is
never emitted for a placeholder. Regression test:
`related-stocks-industry-link.test.tsx`.

### Suburb pages were orphans

URL inspection of `/housing/vic/altona-north`: indexed, last crawled
2026-08-12, **referring URLs: the sitemap only**. `/housing/[state]` renders
its suburb links inside an `ssr:false` explorer, so the state page's HTML
linked to no suburb at all. Fifteen thousand pages hung off `sitemap.xml` and
the nearby-suburb rails.

**Fixed:** `StateSuburbDirectorySection` — a server-rendered directory on
every state page (most expensive, most affordable, fastest growing, largest by
population, plus every ranking page the state has), built from the same
24h-cached suburb index the suburb pages already read. This also lifts the
state pages out of the crawl's "thin content" bucket (they were 107–115
words). Test: `housing/[state]/page.test.tsx`.

A third, smaller one, **left open**: every internal suburb link carries
`?sal=<code>`, so Search Console reports `?sal=` variants of suburb URLs
earning their own impressions. The canonical tag consolidates them, and
`main` pins the query as load-bearing (`states.test.ts`), so removing it is
a decision for the housing owners rather than an SEO edit.

## 3. Housing: what people search for, and what we said back

400 query/page rows for `/housing/`, three months, grouped by intent:

| Intent in the query | Rows | Impressions | Weighted position |
|---|---|---|---|
| bare suburb name | 250 | 421 | 39.9 |
| postcode | 54 | 60 | 42.1 |
| house price / median | 35 | 52 | 39.8 |
| population | 26 | 33 | 22.7 |
| **lga / council** | 11 | 27 | **10.4** |
| suburb profile | 12 | 19 | 36.2 |
| demographics | 2 | 2 | 10.5 |

Bare-name queries are Wikipedia's and the councils'; we will not win those.
The winnable ones are the modifiers, and the page metadata said none of the
words: the title was `X House Prices & Demographics` and the description a
template with no number in it, while "X median house price" queries sat at
position 25–46 and "X lga" at 9–11.

**Shipped:** number-led metadata on every suburb page. Priced:
`Altona North House Prices & Demographics | $960k Median` and a description
that opens with the median, period and year-on-year move, then population,
median age, household income, then council and electorate. Unpriced suburbs
say "Suburb Profile" and their council, never a price. Plus `geo.*` meta
tags with the boundary centroid, and JSON-LD `Place` (+ `Dataset` when priced,
+ `BreadcrumbList`). The leading phrase of the priced title is unchanged on
purpose — the ~3,600 indexed URLs keep the string they rank on; the median is
appended the way `22.80% Shorted` was on the stock titles.

## 4. The crawl (300 pages, Vercel origin)

Discard the two origin artifacts (`canonicalized-page` 270, `noindex-page` 10)
as in August. What remains:

| Finding | Count | Action |
|---|---|---|
| Broken internal link `/industry/food-beverage-tobacco → /shorts/SGLLV` (404) | 1 | **Fixed** — industry rows link only codes the stock page can serve (`hasStockPage`, 3–4 alphanumerics, mirroring the API's validation); five-character hybrid codes render as plain rows |
| Thin content: 8 state housing pages (107–115 words) | 8 | **Fixed** by the directory (§2) |
| Thin content: `/market` (89), `/pricing` (95), `/roadmap` (24) | 3 | Open — `/roadmap` should probably be `noindex`; `/market` and `/pricing` are real pages with client-rendered bodies |
| Multiple H1 on `/blog` | 1 | **Fixed** — the hero post's own `h1` now demotes to `h2`, as on `/blog/[slug]` |
| Missing H1 on `/signin?callbackUrl=…` | 10 | Already `noindex`; the crawler followed the `nofollow` anyway. No action |
| Title > 60 / description > 160 | 203 / 222 | Cosmetic, per August §4 — the new suburb descriptions are deliberately number-first and long |
| Slow response | 207 | Cold ISR during the crawl, as in August |

The **Breadcrumbs "Unnamed item"** that URL inspection reports on industry
pages is Google naming the `BreadcrumbList` itself, which has no `name`; the
items are named. Not a defect.

## 5. Sharing surfaces and internal linking that shipped with this round

- **Suburb Open Graph card** rebuilt on the shared canvas: the archetype scene
  the page banner uses, the suburb's own boundary drawn from the same ABS
  TopoJSON the page's locator draws (projected server-side, `lib/housing/
  suburb-geometry`), and a stat row (median, past year, population; Census
  figures only for unpriced suburbs). State and hub cards carry live figures;
  the industry card carries the sector medallion and the three most-shorted
  stocks with their marks; `/industry-intelligence` names the three most
  crowded sectors.
- **Suburb maps are now server-rendered SVG.** The banner inset and the
  state locator used to be client islands that fetched the whole state's
  boundary file — `/geo/suburbs/VIC.topojson`, 310 KB compressed / 1.2 MB
  decoded, 336 KB / 1.3 MB for NSW — on every suburb visit (confirmed in the
  prod network log on 2026-09-24). They now take pre-projected paths, which is
  ~28 KB of inline SVG (the paths are serialised at pixel precision with
  duplicate points dropped — Victoria's outline went from 78 KB to 11 KB) and
  no client JavaScript. First-load JS for `/housing/[state]/[suburb]` fell
  from 172 kB to 160 kB gzipped; every bundle budget passes with no
  regressions against the July baseline. Lighthouse mobile on the local
  production build (median of 3, against the live API): performance **98**,
  LCP 2.4 s, TBT 0 ms, CLS 0 for `/housing/vic/altona-north`;
  `/industry/materials` 83 / 4.4 s. One landmine found on the way: the ABS
  SAL set contains null-geometry placeholders ("No usual address",
  "Migratory - Offshore - Shipping"), and one of them threw inside the
  neighbour scan and took every Victorian map down on the first render — now
  skipped, with a regression test.
- Three housing posts on `/blog`, data-led from the live API (state-by-state
  2026 guide, where asking prices are being cut, how to read a suburb
  profile), with a `HousingChart` MDX component so posts embed the same live
  series the tracker renders.

## 6. What remains

1. **Authority.** Still unmeasurable here (no DataForSEO key) and still the
   constraint. Nothing in this round moves it; the `/statistics` outreach
   play from July §5 is untouched.
2. **CTR on the stock cluster (§1).** The next experiment is presentation:
   the `X-RateLimit`-style freshness signal worked in titles; a per-ticker
   description that leads with the change ("+2.1pp this week") is the obvious
   next test, measured page-by-page in Search Console.
3. **`/roadmap` noindex**, and a decision on `/market`'s server-rendered body.
4. **A keyed OpenSEO run** for backlinks and volumes — the only way to
   turn the July measurement table (§8) into numbers.
5. **Newsroom cadence.** The editorial pipeline is the freshness engine for
   the stock cluster; it needs its Cloud Scheduler wired (still manual runs).
