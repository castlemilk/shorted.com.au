# SEO Audit — October 2026 (page weight, the picks desk, and the stock-cluster CTR experiment)

**Follows:** `docs/seo-audit-2026-09.md` (first-party data, suburb orphans, the
`not-applic` canonical) and `docs/seo-strategy-2026-07.md` (the strategy).

Method this round: a technical probe of one page of every type on
2026-10-07 against the Vercel origin (`shorted-com-au.vercel.app`, a browser
user agent; `shorted.com.au` still 403s every non-browser client, unchanged
since August and still not a Googlebot problem), the sitemaps, and the ASIC
record behind the content that shipped. Page weights below are the raw HTML
the origin served and its gzip size; "flight" is the React Server Components
payload embedded in that HTML (`self.__next_f.push`), which a crawler
downloads and discards and a phone parses.

<!-- FIRST-PARTY DATA: filled from the OpenSEO instance (Search Console +
GA4) once the MCP is authorised; the September figures are the baseline. -->

---

## 1. The picks desk shipped a 1.85 MB page

The stock picker (`/picks`, five strategy pages, live since late September)
is the newest indexable cluster and the heaviest thing the site serves:

| Page | Raw HTML | gzip | What is in it |
|---|---|---|---|
| `/picks/minervini-trend-template` | **1,852 KB** | 115 KB | 100 table rows, each with a `<details>` fundamentals disclosure; flight 1,178 KB |
| `/picks/crowded-short-breakout` | 1,347 KB | 88 KB | same shape, 10,959 words |
| `/picks/quality-compounders` | 766 KB | 70 KB | |
| `/picks/zanger-breakout` | 617 KB | 66 KB | 20 rows; flight 423 KB |
| `/picks/canslim` | 606 KB | 61 KB | |

Root cause, measured on the served HTML: every ranked row the API returned
(up to 100) was rendered three times on its way to the reader. Once as the
HTML table (the Suspense fallback the crawler reads), once as that fallback's
RSC element tree, and once more as the raw props of the sort island, which
needed all 100 rows to filter `?status=` client-side. On a trending tape the
Minervini template has 100 names in Stage 2, so the page hit the API's
ceiling, and each of those rows carried a rendered fundamentals disclosure
(`sr-only` labels alone were 57 KB).

**Fixed** (this round):

- `shortlistRows` is bounded at `SHORTLIST_MAX_ROWS = 40` (twice the floor
  of 20). Triggered and setup names still come first, in rank order.
- The island receives only those rows plus the server's status counts
  (`countByStatus` over every ranked row), so the chips still read
  "Triggered 60 · Watch 40+" without carrying the rows; a status chip now
  fetches its full list through the same plain-JSON POST the sort chips use,
  with the shortlist's rows of that status standing in, dimmed, until it
  answers. Tests: `shortlist.test.ts`, `picks-sorted-view.test.tsx`,
  `[strategy]/page.test.tsx` ("renders at most 40 rows of a long list").
- The ItemList JSON-LD (15 names) and the crawlable prose are unchanged.

Measured on production after the 2026-10-07 release (deployment
`kx3p9246o`): `/picks/minervini-trend-template` **890 KB raw / 68 KB gz**
(from 1,852 / 115), `/picks/crowded-short-breakout` 864 / 65 (from 1,347 /
88), `/picks/zanger-breakout` 529 / 53 (from 617 / 66), `/picks` 166 / 25.
The 40-row shortlist and the island's slim props account for the drop; the
remaining weight is the shortlist rendered twice (HTML plus the fallback's
RSC tree), each row still carrying its fundamentals disclosure.

### Other heavy pages (open)

| Page | Raw HTML | gzip | Note |
|---|---|---|---|
| `/politicians` | 1,703 KB | 100 KB | 592 table rows and 770 links in the hub; flight 954 KB |
| `/top` | 803 KB | 93 KB | 354 inline SVGs (the per-row sparklines, 125 KB) |
| `/reports` | 427 KB | — | |
| `/housing/vic/altona-north` | 307 KB | 53 KB | down from the September fix; fine |

The politicians hub is the next candidate for the picks treatment (render the
first N rows, fetch the rest), and `/top`'s sparklines could be one sprite or
a client island behind the fold. Neither is a ranking emergency; both are
mobile cost.

## 2. Stock cluster: the description now leads with the change

September §6.2 left one experiment open: the per-ticker pages rank at
positions 3 to 7 with 1 to 4% CTR, and the meta description led with the
level ("Droneshield short interest is 15.07% as of 30 Sept 2026"), which the
title already states. **Shipped:** the description now carries the 30-day
move next (", up 0.64 points in 30 days" / ", down 1.20 points in 30 days" /
", unchanged over 30 days"), computed from the same cached daily ASIC series
the page's history summary already reads, so it costs the metadata no extra
request; an unavailable series drops the clause. `lib/seo/short-change-clause.ts`,
unit-tested. Measure page by page in Search Console against the September
baseline (`/shorts/DRO` 1.1% at 4.0, `/shorts/4DX` 3.6% at 3.4).

## 3. Probe findings, page by page

One page of every type (2026-10-07):

| Page | Title / H1 / canonical | Words | Finding |
|---|---|---|---|
| `/` | ok, 1 H1 | 2,548 | 261 KB; FAQ + Organization JSON-LD |
| `/top` | ok | 1,882 | weight (§1) |
| `/shorts/DRO` | ok, no explicit robots meta (default index) | 1,717 | description (§2) |
| `/battlegrounds` | ok | 1,050 | **4.65 s** TTFB on the probe: a cold ISR regeneration; warm afterwards |
| `/picks/*` | ok, Dataset + ItemList + Breadcrumb JSON-LD | up to 10,959 | weight (§1) |
| `/blog/<slug>` | ok, BlogPosting + Speakable | 2,564 | fine |
| `/blog` | ok, one H1 (September's fix holds) | 2,016 | 24 BlogPosting items |
| `/news` | ok | 1,353 | ItemList; news sitemap carries `lastmod` |
| `/housing/vic/altona-north` | ok, number-led title (September) | 1,808 | fine |
| `/economy/vic` | ok | **463** | the thinnest indexable page type; the body is client-rendered charts. Open: a server-rendered summary paragraph per state, as the suburb directory did for `/housing/[state]` |
| `/politicians` | ok | 9,099 | weight (§1) |
| `/industry/energy` | ok, number-led description | 1,201 | fine |
| `/screener` | ok, WebApplication JSON-LD | 723 | fine |
| `/statistics` | ok | 942 | fine |
| `/roadmap` | ok | 1,909 | **no longer thin**: the tree is server-rendered under monthly headings. September's "noindex it" item is closed without action |
| `/market` | ok | 3,674 | September's "client-rendered body" concern is closed: the snapshot table is in the HTML |

Sitemaps: `/picks` and the five strategies are in `sitemap-core.xml` (528
URLs), `/news/` 35 URLs with `lastmod`, `/blog/` 28; housing, politicians
and reports have their own indexes (172 report URLs). `robots.txt` allows
`/picks` explicitly for the AI crawlers.

One trap for internal linking, not a defect: a report's MCP slug
(`2026-W40`) is not its URL
(`/reports/weekly/10-most-shorted-asx-stocks-week-40-2026`). The articles
in §4 link the URL.

## 4. Content that shipped with this round

Data-led, from ASIC's 30 September 2026 file (verified against the CSV row
by row; the T+4 lag means it was the latest print on 7 October):

- `/blog/asx-stocks-under-fire-october-2026`: the dated October edition of
  the most-shorted piece (the evergreen `/blog/most-shorted-asx-stocks` keeps
  its URL and gets the link), with the top ten, four-week builders and
  coverers, the sector shape (uranium, lithium, defence, the lottery
  rotation) and the days-to-cover table. Targets "most shorted ASX stocks
  October 2026" and its variants.
- Three newsroom takes, staged in `content/news/` for the publish job
  (`publish-content` imports them as drafts; nothing auto-publishes):
  `tlc-shorts-double-from-august-low-keno-ban-jackpot-drought` (192.0M
  shares short, twice the 5 August count, 18.4 days to cover, against the
  FY26 jackpot drought, the online-Keno ban in Act No. 72 of 2026 and the
  Victorian licence), `boe-shorts-rebuild-to-13-6pc-new-chair-honeymoon-plan`
  (8.46% on 26 August to 13.58%, the Honeymoon study, Macquarie's 5.12%, the
  chair succession) and `eos-shorts-double-into-25pc-rally` (4.73% to 10.15%
  in a quarter while the price rose 25%, the JIATF 401 marketplace listing,
  the Vanguard and Citigroup notices). Each was written, then adversarially
  checked against the ASIC files and every opened source, then fixed; the
  sources files record how each URL was verified.

## 5. What remains

1. **Authority.** Unchanged and unmeasured (no DataForSEO key on the OpenSEO
   instance); the `/statistics` outreach play from July §5 is untouched.
2. **First-party measurement** of §1 and §2: Search Console page-level CTR
   for the stock cluster four weeks after deploy; crawl stats for the picks
   pages.
3. `/politicians` and `/top` weight (§1), `/economy/[state]` thin bodies (§3).
4. The newsroom cadence item from September stands: the three takes above
   were hand-written and reviewed; the scheduled pipeline is still a manual
   run.

---

## 6. Follow-up, 2026-10-15: first-party data and a crawl of the real domain

Search Console via the OpenSEO connector (windows end 2026-10-12), and a
500-page OpenSEO crawl of `https://shorted.com.au/` itself on 2026-10-15
(it no longer needs the Vercel origin). DataForSEO stays off by the owner's
decision, so there are still no volumes, SERPs or competitor rankings.

**Where things stand.** Daily clicks rose from 1-2 in April to 30-64 in
October; impressions from about 150 to 3,500-4,000 a day. Last 28 days: 783
clicks, 66.5k impressions, CTR 1.2% (mobile 1.4%, desktop 1.0%), average
position about 8.3. `/shorts/*` took about half the clicks.

**Stock-cluster CTR (§2).** Three months to 10-12: `/shorts/DRO` 1.3% at 3.8
(September 1.1% at 4.0), `/shorts/4DX` 3.4% at 3.4 (3.6% at 3.4). Not
conclusive, and the baseline moves again with this round's title change.

**Striking distance (3 months).** "asx short positions" 1,129 impressions at
7.7, 1.2% CTR; "asx most shorted stocks" 1,011 at 9.3, 0.3%; "asx shorts" 889
at 7.2; "asx short interest lotus" 830 at 3.6 with 0.4% (`/shorts/LOT`); "asx
heavily shorted stocks weekly" 673 at 4.8, split between `/` and
`/reports/weekly`; "shorting australian banking stocks" 680 at 7.8 with one
click and no page aimed at it. Searches naming the competitor ("shortman
4dx", "shortman stocks", "zip shortman") show Shorted at 5-7.

**Shipped:**

1. The root layout no longer declares `alternates`. Every page without its
   own canonical inherited `https://shorted.com.au` as its canonical (crawl:
   `/pricing`, `/terms`; code: `/docs/api` and children, `/developer`,
   `/alerts`, `/pulse`, `/roadmap`, `/dashboards`, `/housing/drops`), and the
   hreflang set pointed at the homepage from every page too. `/pricing` and
   `/terms` now name themselves. `app/__tests__/root-canonical.test.ts`.
2. Stock titles shortened from about 70 characters to about 45:
   "4DX Short Interest: 10.91% (4Dmedical, ASX) | Shorted"
   (`lib/seo/stock-page-title.ts`).
3. A stock whose newest ASIC report is over 90 days old keeps its page but
   drops the %, the 30-day move and "Updated daily" from its snippet (AGF
   read "2.52% Shorted ... up 2.52 points in 30 days ... Updated daily" from
   a 30 Dec 2016 report). `isStaleShortDate` in `lib/stocks/as-of-date.ts`.
4. Cloudflare Email Obfuscation off (Terraform): it rewrote every `mailto:`
   to `/cdn-cgi/l/email-protection`, 13 broken internal links in the crawl.
5. `/pricing` rendered "Pricing — Shorted | Shorted"; now "Pricing | Shorted".

**Open:**

- News cards link `/shorts/<CODE>` for every tagged code; 214 codes tagged
  in the last 30 days have never appeared in ASIC's report and have no stock
  page (the homepage linked ANT and WC1, both 404). Product call: render a
  company page without short data, or link only codes that have one.
- `/` and `/top` both target "most shorted ASX stocks" (`/` at 7-9, `/top`
  about 13). The homepage title keeps the phrase on purpose; retargeting one
  of them is the owner's call.
- `/compare/*`: 123 pages with impressions, 4 clicks in 28 days, and they
  show up under the stock page for the same query. `/glossary/*`: 67 pages,
  2 clicks, entries of 130-150 words. Candidates for noindex or merging.
- Economy state pages answer in 1.6-3.1s on a cold cache.

---

## 7. Round of 2026-10-21: technical probe, ISR, page weight and stale data

No first-party data this round. The OpenSEO connector was not authorised (it
needs the owner's Cloudflare Access sign-in), so there are no Search Console
figures and no crawl of the real domain, and §6's 2026-10-15 baseline stands
(28 days: 783 clicks, 66.5k impressions, CTR 1.2%, position about 8.3).
Instead, on 2026-10-21, with the code read at `origin/main` 9acd3e126:

- a probe of one page of every type, and of the routes added since 10-14, on
  the Vercel origin (Chrome user agent, at most three requests in flight, 255
  requests), with 25 URLs from each sitemap child and 141 internal link
  targets;
- a weight and timing probe of about 20 pages, two sequential GETs each (84
  requests): raw HTML, gzip, the RSC flight, TTFB and `x-vercel-cache`;
- read-only production queries through `task db:prod:psql`: tagged news codes
  against ASIC rows, politician duplicates, linked codes no sitemap lists,
  the screener rows behind `/statistics`, suburb slugs and postcodes, and a
  plain `EXPLAIN` (no `ANALYZE`) of the price-drops address board.

KB below is 1,024 bytes. "Simulated" means the fix was spliced into the page
the origin served and the page re-gzipped, not measured on a deployment.
Re-gzipped sizes run 5-10% under what Vercel serves, so read the deltas.

### Findings and their status

| # | Finding (evidence 2026-10-21) | Status |
|---|---|---|
| F01 | `/price-drops` took 44.1 s and 44.2 s on two GETs 20 minutes apart (`REVALIDATED`, `Age: 0`) | shipped, in three deploys |
| F02 | `/statistics`' "4-week moves" led by codes last reported 2011-2023 (CSJ 2012, REY 2011) | shipped for `/statistics`; the view needs DDL |
| F03 | no robots or googlebot meta on 6,655 sitemap URLs (`robots: undefined`) | shipped |
| F04 | about 944 sitemap URLs rendered per request, `private, no-store` | shipped, except `/screener` (owner call) |
| F05 | 19 MPs with two indexable profiles each | owner call (register console) |
| F06 | take snippets open with Markdown links; take titles of 96-115 characters | shipped |
| F07 | `/docs/api` serves the homepage's title; no canonicals; pages of about 1.9 MB | shipped |
| F08 | the 70 economy topic pages linked only from each other; `/economy/vic` 114 words | shipped |
| F09 | `/ownership/<slug>` (new 10-17): unsitemapped, empty pages indexable, titles of 70-85 | shipped; holdings-file-only institutions need an API field |
| F10 | suburb links carry `?sal=`; price-drops links use postcode slugs that 308 or 404 | shipped |
| F11 | links to stock pages that do not exist (news cards; ERL from `/politicians`) | owner call |
| F12 | titles that repeat the brand; `/alerts` indexable and thin | shipped; `/pulse` is an owner call |
| F13 | `Dataset.dateModified` is the render time on `/`, `/battlegrounds` and `/data` | shipped |
| F14 | templated titles of 70-98 characters | shipped, except `/features/the-widow-maker` (79) |
| F15 | the footer links `/dashboards` and `/portfolio`, which 307 to the noindexed sign-in, on 46 of 47 pages | shipped |
| F16 | `/roadmap` thin again (100 words) | shipped |
| F17 | 20 px logos list 16 `srcSet` widths (747 KB of `/reports/weekly`) | shipped |
| F18 | `/shorts/ANT` titled "0.00%" | shipped |
| F19 | `/compare/*` (80 pairs) and `/glossary/*` (83 terms) thin and indexable | owner call, unchanged |
| F20 | `/` and `/top` share "most shorted ASX stocks" | owner call, unchanged |

### Shipped

**Freshness (F01, F02, F13, F18).**

- **F01.** The 44 s was the address board, not the overview RPC the review
  suspected. `ListAddressPriceDrops` failed `internal` at 10.2 s (the store's
  10 s deadline) and the action retried it three times: 4 × 10.2 s plus 3.5 s
  of backoff, then an empty seed baked into the page. The other four RPCs
  answered in 0.27-0.47 s. One fix per deploy:
  - web: the seed makes one attempt under a 2 s deadline, and the browser
    asks once (`app/actions/getHousing.ts`,
    `app/actions/client/getHousingClient.ts`);
  - API: each board row's listing count is one index probe
    (`services/shorts/internal/store/shorts/postgres_house_prices.go`).
    Production's plain `EXPLAIN` costs the query at 34,240 against 46,620,
    and the step that grew with the square of the board is gone; its runtime
    is unmeasured until the deploy;
  - rig: a crawl drain revalidates once when it ends, and at most hourly in a
    long drain, instead of after each of up to 30 rounds. Each round's ping
    purged `/price-drops`, `/housing`, every state and suburb page and the
    housing KV prefix
    (`services/house-price-collector/deploy/housing-crawl-common.sh`, the
    new `-mode revalidate`).

  Declined: serving the stale page while it regenerates (in Next 14.2.13
  `revalidatePath` is a tag revalidation, which blocks; it needs Next 16),
  and a KV last-good copy of the board (its rows are licence-restricted and
  kept out of shared KV, so that a takedown stops serving them).
- **F02.** `/statistics` counts only the codes in the latest ASIC report
  (`app/actions/getShortStatistics.ts`). On production, where the 10-15 report's
  828 codes cover 712 of the screener's 3,299 rows: companies 3,299 to 712,
  average short interest 0.43% to 1.55%, at 10% or more 18 to 16, at 5% or
  more 79 to 69, rows without a market cap 1,589 to 24, total $108.73B to
  $108.55B. An unreadable report withholds the figures and caps the render at
  a minute for every reader (`/statistics`, `/press`, the share card). The
  screener's pages after the first go four at a time; 17 sequential calls
  took 1.7 s cold.
- **F13.** `DatasetStructuredData` leaves `dateModified` out when it gets no
  date. `/` passes its ASIC "as at" date, `/data` its latest report,
  `/battlegrounds` the latest report date and `/top` its latest data point (it
  fell back to the render time on an empty series). An insider page's Article
  is dated from its trades.
- **F18.** A position that rounds to 0.00% is stated as no level
  (`lib/stocks/short-percent.ts`). ANT, 164 shares short, is titled "ANT
  Short Interest (Arcadia Minerals, ASX)"; its header, summary and About card
  read "<0.01%", its social card "<0.1%", and its Dataset has no `value`.

**ISR (F04).**

- Blog posts, compare pairs, takes and insider pages (about 940 sitemap URLs)
  are on-demand ISR: an empty `generateStaticParams` and `dynamicParams =
  true` beside the `revalidate` that was inert without them. Takes and
  insider pages became ISR only after their reads failed closed. A 404 comes
  only from NotFound, and a failed read throws, so Next keeps the last good
  page instead of caching a 404 or "No director trades recorded" for the
  whole revalidate (`getEditorialTakeOrNotFound`; the insider page also 404s
  codes the API rejects). A take's related block caps its render at a minute
  when one of its reads fails. A compare pair with a code GetStock cannot
  take 404s before any read.
- `/shorts` dropped the `force-dynamic` that made its `revalidate = 600`
  inert; `/scans` is ISR at 900 s and its six scan pages on demand;
  `/housing/calculators` reads its `?price=&state=` prefill in the browser.
- `/battlegrounds` was `STALE` on every request with a frozen `age` (594 s,
  then 665 s). Its Connect read had no `next` lifetime, went `no-store` at
  runtime and threw inside every regeneration, after 3.5 s of retries. The
  read is tagged (`app/actions/getBattlegrounds.ts`), and the retry helpers
  no longer retry Next's dynamic-usage signal (`lib/retry.ts`).
- `/ownership/<slug>` fails its regeneration on a failed read instead of
  caching a 404.
- The post-promote sweep (`config/isr-pages.json`) now covers `/shorts`,
  `/battlegrounds`, `/housing/calculators`, `/ownership` and the 70 economy
  topic pages, whose build renders hold no data.
- Guards: `app/__tests__/isr-static-params.test.ts`, `isr-hubs.test.ts`,
  `isr-degraded-render.test.ts`,
  `app/actions/__tests__/serverApiSurface.test.ts` and
  `config/__tests__/isr-shell-pages.test.ts`.
- Declined: `/screener` stays per request. It reads `?preset=` on the server
  only to give each preset URL its own title and canonical, which
  `e2e/seo-smoke.spec.ts` pins. Whether presets keep their own URLs is the
  owner's call.

**Metadata (F03, F06, F07, F09, F12, F14).**

- **F03.** Indexable suburb, politician, report and insider pages omit the
  `robots` key, so they now inherit `max-image-preview:large` and
  `max-snippet:-1` (`app/__tests__/robots-undefined.test.ts`).
- **F06.** Take descriptions drop Markdown links and MDX tags. Titles are the
  headline alone (`title.absolute`), cut at the first clause only past 80
  characters: Boss Energy 96 to 71, EOS 115 to 59, TLC 97 to 72.
  `NewsArticle.about` names the company.
- **F07.** `/docs/api`, its 85 endpoint pages and its six client guides have
  their own titles and canonicals, with the brand once
  (`app/docs/api/docs-metadata.ts`). The endpoint pages left `sitemap-core`
  (every docs page's sidebar links them), and the OpenAPI parser no longer
  turns path-level `servers` into two junk `SERVERS` pages
  (`lib/openapi/parser.ts`). The spec has 85 operations, not the 164 the
  review counted.
- **F09.** One predicate, `lib/ownership/indexability.ts` (a current stake or
  published holdings files), sets the noindex, which about 83 of the 145
  institution pages now carry, and fills the new `sitemap-ownership.xml`: the
  56 institutions with a stake, and `/ownership` dated from its own `asOf`
  (10-20, not the ASIC date). Titles fit 60 characters before the brand. The
  hub and each institution have a social card, institutions a
  `BreadcrumbList`, and `llms.txt` and `llms-full.txt` list `/ownership`.
- **F12.** The brand is gone from the titles of `/data`, `/insider-trading`,
  `/authors/*`, `/alerts`, `/pulse`, `/press`, `/roadmap` and `/search`.
  `/alerts` is noindex, follow, with its own canonical
  (`app/__tests__/title-brand.test.ts`, whose allowlist is empty).
- **F14**, rendered lengths: `/economy` 98 to 64; councils 75-87 to 65 or
  less, all 547 checked and none duplicated
  (`app/housing/[state]/council/council-titles.ts`); `/economy/[state]` 68-88 to
  49-64; `/market/<date>` 77 to 67; DRO's Company tab 77 to 65 and Strategy
  tab 73 to 67, with the Short interest, Financials and Community tabs on the
  same budget (CBA's Financials tab was 87; `lib/seo/stock-tab-title.ts`);
  `/seasonality` 77 to 68; `/scans` 75 to 61; monthly reports 70-86 to about
  50, the series title, with the headline moved to the social cards
  (`app/__tests__/title-length.test.ts`).

**Links and thin pages (F08, F10, F15, F16).**

- **F08.** Each state page server-renders its topic pages (9, or 8 for NT and
  ACT) with a sentence of the latest reading, about 150 words on top of
  `/economy/vic`'s 114, and the hub links all 70 (`app/economy/page.tsx`,
  `app/economy/[state]/page.tsx`). The links carry `prefetch={false}`:
  viewport prefetch would have fetched 0.9-1.4 MB gzip per hub view. The NT
  and ACT titles no longer promise an unemployment rate they do not show.
- **F10.** `suburbHref` returns the canonical path, with no `?sal=`
  (`lib/housing/states.ts`). The price-drops boards link by the ABS name,
  without the crawl postcode: for an ABS-qualified name the postcode slug was
  a 404 (`/housing/nsw/abbotsford-nsw-2046`), not a 308, and that URL now
  resolves.
- **F15.** The footer's `/dashboards` and `/portfolio` links carry
  `rel="nofollow"` for signed-out visitors (`components/ui/site-footer.tsx`).
- **F16.** `/roadmap` server-renders its 31 features by status beneath the
  tree: 373 words in a test render, from 100
  (`app/roadmap/roadmap-feature-list.tsx`).

**Also shipped, from the security review.** Every JSON-LD block goes through
one serializer that escapes `<`, `>` and `&` (`components/seo/json-ld.tsx`);
output without those characters is byte-identical, so crawlers read the same
schema. A stored URL becomes a link only when it is http(s)
(`lib/safe-external-href.ts`). Social cards fetch images only from Cloud
Storage and this site's `/assets/`, over https (`lib/og/image-fetch.ts`).

### Page weight and response time

| Page | Before (served 10-21) | After | How |
|---|---|---|---|
| `/top` | 781 KB raw / 83 KB gz | 376 / 40 | simulated. The island gets each row's latest value, change and at most 30 sparkline points, not 100 series of 60 dated points (props 396 to 27 KB); the HTML is unchanged |
| `/politicians` | 1,660 / 93 | 719 / 83 | simulated. The roll of 491 and the 200-row most-declared list render as plain elements and links: flight 954 to 388 KB, DOM 9,844 to 6,708 elements, every profile and stock link kept |
| `/picks/minervini-trend-template` | 877 / 64 | 471 / 50 | simulated. The island draws its own Suspense fallback, so the fallback's element tree leaves the flight; the HTML is unchanged |
| `/ownership/vanguard` | 936 raw | 366 raw | simulated. Every stake and holdings-file row stays in the HTML; the notices show the newest 25; the link icon is drawn once |
| `/ownership` | 673 raw | 604 raw | simulated |
| `/reports/weekly` | 1,723 / 54 | 1,061 / 44 | simulated. Fixed-size logos list a 1x/2x pair: a 20 px logo's tag goes from 2,003 to 512 bytes |
| `/reports` | 405 / 30 | 273 / 27 | simulated, the same fix |
| `/docs/api` | 1,963 raw | 284 raw | simulated by replaying the saved page. The header and sidebar get a slim endpoint list: props 1,464 to 40 KB. The Java guide 1,853 to 164, `GetInstitution` 1,913 to 234 |
| `/economy` series read | 149 KB | 4 KB | measured. The hub and state pages ask for the latest observation only (Victoria's read 32 to 1 KB) |

Response times, before only (nothing is deployed yet):

- `/price-drops`: 44.1 s and 44.2 s. After a purge the render should wait at
  most the 2 s seed budget plus 0.3-0.5 s of reads.
- `/battlegrounds`: 4,376 ms after a purge, then `STALE` on every request. It
  should regenerate in the background like the other ISR pages; its RPC
  answers in 212-245 ms.
- `/statistics`: 1,728 ms cold, from 17 sequential screener calls. The change
  makes that five rounds of calls, plus one report read per new report date
  (measured at 2.56 s cold, 0.27 s warm).
- The F04 URLs were `private, no-store` and a MISS on every request. From the
  second request they should be `public, max-age=0, must-revalidate` and a
  HIT.

### Corrections to §1, §3 and §6

- §1: `/top`'s 354 inline SVGs are its row icons, not the sparklines, which
  render in the browser. Its weight was a 394 KB prop. The picks page's
  remaining weight was not inherent either: the fallback's RSC copy could go
  without touching the HTML.
- §3: `/battlegrounds`' 4.65 s was not a cold regeneration. It was 3.5 s of
  retries on a `no-store` fetch, on every regeneration, and the page stayed
  `STALE`.
- §3: `/roadmap`'s 1,909 words did not reproduce. It served 100, because the
  page is a client component.
- §6: the economy state pages answered a cold request in 546-828 ms across
  six states, not 1.6-3.1 s.

### What remains

1. **Owner calls.**
   - `/compare/*` (80 pairs; `/compare/DRO-vs-LOT` has 199 words) and
     `/glossary/*` (83 terms; `/glossary/hedging` 194): noindex or merge.
   - `/` against `/top` for "most shorted ASX stocks": no new data this round.
   - The 19 duplicate politician profiles, both slugs of each pair indexable
     and in the sitemap. Merge each pair in the register console
     (`/admin/register/politicians`, with `merge_evidence`); a merged slug
     already 308s and leaves the lists and the sitemap. The pairs:
     chris/christopher-bowen, anthony/tony-burke, james/jim-chalmers,
     elizabeth/libby-coker, pat/patrick-conroy, michael/mike-freelander,
     steve/steven-georganas, alex/alexander-hawke, chris/christopher-hayes,
     ed/edham-husic, rob/robert-mitchell, llew/llewellyn-o-brien,
     antony/tony-pasin, hom-keith/keith-pitt, rebeka/rebekha-sharkie,
     dan/daniel-tehan, matt/matthew-thistlethwaite, tim/timothy-watts and
     josh/joshua-wilson. A given-name alias rule (James/Jim, Antony/Tony)
     would stop `register-load` minting more.
   - `/pulse`: Premium-gated like `/alerts`, but indexable with no canonical.
     Noindex it with a canonical as `/alerts` now is, or keep it.
   - Codes without a stock page. News cards link every tagged code, and 217 of
     the 2,151 codes tagged in the 30 days to 10-21 have no ASIC row (AYM in
     124 articles, SET 31, NMD 25). The `/politicians` most-declared table
     links ERL, a 404. Render a company page without short data, link only
     codes that have a page, or at least drop the chip on the homepage strip.
   - `/screener` presets: canonicalise `?preset=` to `/screener`, which lets
     the page be ISR, or give presets an ISR segment of their own.
2. **Needs DDL or an API deploy.**
   - Bound `latest_shorts` in `mv_screener_data` (a new view migration,
     applied by hand), or carry each row's short date on `ScreenerStock`.
     `/screener` and the MCP `screen_stocks` tool still show codes ASIC
     stopped reporting, and so do `/scans` (CSJ, last reported in 2012, leads
     short-interest-rising, with EHE, CZZ, TPD and RDH in its top six) and
     `/battlegrounds` (CAN in the squeeze top 25).
   - The holdings-file signal for the sitemap. `ListInstitutions` carries no
     holdings-file count, so `sitemap-ownership.xml` lists only institutions
     with a stake. HESTA, Betashares and about four other funds that qualify
     on their holdings files alone are indexable but unlisted until
     `OwnershipInstitution` gains the field (proto, `ownership.go`,
     regeneration, API deploy). The page needs no change.
3. **Measure after the deploy.**
   - Two sequential GETs per route, Chrome user agent, on the Vercel origin:
     `/blog/<slug>`, `/news/<take>`, `/compare/DRO-vs-LOT`,
     `/insider-trading/BHP`, `/shorts`, `/scans`,
     `/scans/short-interest-rising`,
     `/housing/calculators?price=750000&state=VIC` and `/battlegrounds`. The
     second must be `public, max-age=0, must-revalidate` and a HIT. On
     `/price-drops` the first GET after a purge should take under about 2.5 s
     and the second should be a HIT.
   - `/statistics` should read about 712 companies, with none of CSJ, EHE,
     CZZ, TPD or REY among its movers.
   - Search Console page-level CTR for the stock cluster four weeks after the
     deploy, the Overview pages apart from the tabs; crawl stats for
     `/price-drops` and `/docs/api`; and the 500-page crawl again once OpenSEO
     is authorised.
4. **Smaller.** `/features/the-widow-maker` still renders at 79 characters.
   The `/feed.xml` and `/v1/latest` docs titles (66, 69) come from the spec's
   summaries. `/compare`'s "as of" line and `WebPage.dateModified` are the
   render time. About 30 cached social cards prerender without data at build,
   and no sweep refreshes them. The jobs still purge without re-priming what
   they purge (the perf review's fix 7), so the first reader after each daily
   purge, often a crawler, waits for the render: 0.3-1.6 s on the stock pages
   and tabs sampled.

**This round moves §6's baselines.** The Company and Strategy tabs have new
titles, and the other tabs drop a company name that does not fit. The
indexable suburb, politician, report and insider pages now carry
`max-snippet` and `max-image-preview`. About 950 URLs move from per-request
rendering to ISR. Take, council, economy and monthly report titles change.
`/alerts` and about 83 institution pages are noindexed, and `/statistics` now
states 712 companies, not 3,299. So compare Search Console windows that start
after the deploy with each other. The stock Overview pages (`/shorts/DRO`,
`/shorts/4DX`) keep their titles and descriptions unless a position rounds to
zero, so §6's figures stay their baseline.
