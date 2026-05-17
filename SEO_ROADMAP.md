# Shorted.com.au — SEO Roadmap

Tracking the next wave of SEO improvements after the news platform ship
(PRs #110–#117). Items ordered by impact-to-effort within each tier.

Effort: **S** = ≤1 day, **M** = 2-5 days, **L** = 1-2 weeks.

---

## Tier 1 — Highest impact

### 1. Glossary scale-up: 26 → 100+ terms — `[S, very high impact]`

Every term is an indexable long-tail page. AI-draft + editorial review.

Buckets to cover:
- **Short selling mechanics** (covered call shorting, naked short, locate, recall, rebate rate)
- **Ratios & metrics** (days-to-cover, short interest %, utilisation, borrow fee, NAV)
- **Market structure** (T+2 settlement, ex-clearing, market on close, opening auction)
- **Regulators & venues** (ASIC, ASX, ASX 24, Chi-X, BlockEvent, ASX Trade)
- **Risk concepts** (margin call, gamma squeeze, beta, R/R, drawdown, volatility)
- **Behavioural** (capitulation, panic, FOMO, herding)
- **Macro/AU-specific** (RBA cash rate, AUD parity, banking royal commission)
- **Reporting cycles** (T+4 short report, half-year, full-year, Q3 update)
- **Corporate actions** (rights issue, SPP, share buyback, bonus issue)
- **Tax & legal** (CGT discount, franking credits, wash sale, related-party)

**Acceptance**: 100+ slugs in `web/src/@/data/glossary-terms.ts`, each with
a `DefinedTerm` schema, internal links to ≥2 other terms + ≥1 stock/sector.

### 2. Programmatic sector hubs — `[M, very high impact]`

`/sectors/banking`, `/sectors/mining`, etc. No page exists for
"[sector] short selling ASX" queries today. ~12 sectors × ~800 unique words.

Each sector hub:
- Title: "[Sector] Short Selling on the ASX | Live Data + Top Shorts"
- Self-updating top-10 shorts in that sector (from `mv_treemap_data`)
- Sector-aggregated short %, trend chart
- 3-paragraph editorial intro (manual or AI-drafted)
- `Dataset` schema + `Article` schema
- Internal links: top stocks in sector, sector glossary terms, related sectors

**Acceptance**: 12 sector pages live, each with unique 600+ word intro and
indexable in sitemap.

### 3. Knowledge Graph `sameAs` anchors — `[S, high impact]`

On `/shorts/[code]`, add `Corporation` schema with `sameAs` array to
Wikipedia, Wikidata, ASX, Bloomberg. Disambiguates entity for AI Overviews.

Needs a wikidata/Wikipedia lookup pass. Cache result in
`company-metadata.wikidata_qid`, `wikipedia_url`.

**Acceptance**: Top 100 stocks have `sameAs` populated. Schema validates
in Rich Results Test.

### 4. Google News Publisher Center — `[S, high impact, owner action]`

Register `shorted.com.au` at [publishercenter.google.com](https://publishercenter.google.com),
submit news sitemap, verify ownership. Unlocks Top Stories carousel
+ News tab. NewsArticle schema already shipped — this is activation.

---

## Tier 2 — Strong moves

### 5. Author byline + `/authors` page — `[M, high impact]`

E-E-A-T Author signal is mandatory for finance YMYL content. Without it
Google discounts every page.

Build:
- `/authors/[slug]` route with `Person` schema (sameAs LinkedIn/Twitter,
  photo, bio, qualifications, articles list)
- Author field on blog posts + weekly reports + news cards
- ≥2 authors (editorial + data/ML) with real bylines

### 6. WebSite schema + Sitelinks search box — `[S, medium impact]`

In root `layout.tsx`:
```json
{
  "@context": "https://schema.org",
  "@type": "WebSite",
  "url": "https://shorted.com.au",
  "potentialAction": {
    "@type": "SearchAction",
    "target": "https://shorted.com.au/search?q={search_term_string}",
    "query-input": "required name=search_term_string"
  }
}
```

Needs `/search` page accepting `?q=`. Currently only `nav-search-input.tsx`
exists client-side.

### 7. Director/insider trades hub — `[M, medium impact]`

You have `director_trades` data + `GetDirectorTrades` RPC. Build:
- `/insider-trading` — recent insider activity across ASX
- `/insider-trading/[code]` — per-stock insider history
- Schema: `Article` + `ItemList`
- Link from `/shorts/[code]` → `/insider-trading/[code]`

Zero competition in AU market.

### 8. Weekly report dynamic OG images — `[M, medium impact]`

`@vercel/og` per-report chart cards. Replace generic report OG image
with this week's biggest movers. Social CTR lift.

---

## Tier 3 — Quick wins

### 9. `preconnect` for image CDNs — `[S, S impact]`
LCP improvement on `/news`. Domains: `kalkinemedia.com`, `stockhead.com.au`,
`fool.com.au`, `smallcaps.com.au`.

### 10. llms.txt expansion — `[S, S impact]`
Add LLM grounding for `/news`, `/glossary`, `/sectors`. Helps AI Overviews
disambiguate shorted.com.au as the ASX-short-selling source.

### 11. Audit news image CLS — `[S, S impact]`
Lazy-load is already on but verify aspect-ratio is locked to prevent CLS.

### 12. Cross-link weekly reports → stocks — `[S, M impact]`
Audit weekly reports for 100% coverage of stock mentions → `/shorts/[code]`.

---

## Tier 4 — Longer plays (queue)

### 13. Real-time price + short overlay chart — `[L]`
Visual moat. Annotate price chart with ASIC short reports as overlays.

### 14. Dataset Hub at `/data` — `[M]`
Public dataset listing with downloadable CSVs. Each gets `Dataset` schema
→ Google Dataset Search inclusion.

### 15. Story clustering on `/news` — `[L]`
Apple Stocks UX parity. Group same-event coverage from 4+ sources into
1 card with source-count badge.

### 16. More news sources — `[M]`
ABC News Business, SMH Business, Reuters AU, livewire markets. Wire
`asx-announcement-crawler` output into news_articles.

### 17. Resolve googlenews redirects — `[M]`
2.6k articles have googlenews URLs that redirect to source publishers.
Follow redirects via stealth client, scrape og:image from destination.

---

## Tracking

PRs landing for each item should link back to this file. Update with
ship date as items close out.

| # | Item | PR | Shipped |
|---|---|---|---|
| 1 | Glossary 26 → 82 terms | #125 | 2026-05-17 |
| 2 | Programmatic sector hubs | — | **deferred** (needs editorial copy) |
| 3 | sameAs Knowledge Graph anchors | #119 | 2026-05-17 |
| 4 | Google News Publisher Center | — | **owner action** |
| 5 | Author byline + /authors | — | **deferred** (needs editorial identity) |
| 6 | WebSite schema + Sitelinks search | #118, #126 | 2026-05-17 |
| 7 | Insider trades hub | #120 | 2026-05-17 |
| 8 | Weekly + monthly + yearly report OG images | #121 | 2026-05-17 |
| 9 | preconnect news image CDNs | #126 | 2026-05-17 |
| 10 | llms.txt expansion | #129 | 2026-05-17 |
| 11 | NewsCard CLS fix | #128 | 2026-05-17 |
| 12 | LinkifiedNarrative for weekly reports | #131 | 2026-05-17 |
| 13 | Price + short interest dual-axis overlay chart | #134 | 2026-05-17 |
| 14 | /data Dataset Hub | #122 | 2026-05-17 |
| 15 | Story clustering on /news | #124 | 2026-05-17 |
| 16 | 5 new ASX news sources (ABC, SMH, Age, AFR, BNA) | #127 | 2026-05-17 |
| 17 | Googlenews redirect resolver | #123 | 2026-05-17 |

**Plus, not on original roadmap but shipped:**

| What | PR | Shipped |
|---|---|---|
| Sitemap quality filter (961 → 300 stocks) | #110 | 2026-05-16 |
| noindex thin stock pages | #110 | 2026-05-16 |
| spatialCoverage schema fix | #110 | 2026-05-16 |
| /news + /shorts/[code]/news | #112 | 2026-05-16 |
| News hero images (RSS extraction) | #112 | 2026-05-16 |
| OG-image backfill (daily scheduler) | #117 | 2026-05-17 |
| Sitemap + robots for new surfaces | #130 | 2026-05-17 |
| Cloudflare ruleset state imports | #132–#133 | 2026-05-17 |

**Remaining owner-actions:**
1. Register at [publishercenter.google.com](https://publishercenter.google.com) (item #4)
2. Decide author identity → I'll build /authors when you give me at least one (item #5)
3. Re-evaluate sector hubs (item #2) — only blocked on editorial copy

Last updated: 2026-05-17
