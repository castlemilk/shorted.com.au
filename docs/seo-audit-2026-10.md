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
