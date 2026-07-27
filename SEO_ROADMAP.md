# Shorted.com.au — SEO Roadmap

Living roadmap. Current phase: **post head-term retarget (July 2026)** —
companion to the full research doc at `docs/seo-strategy-2026-07.md`
(13-agent competitive research, 2026-07-15). The May 2026 wave and its
tracking table are preserved in §6.

Last updated: **2026-07-27**

---

## 1. Where we stand (27 July 2026)

A 25-July SERP snapshot had shorted.com.au at **~#9** for the
"asx short selling" cluster, behind ASIC, ShortMan, Market Index, Small Caps
and ShortInterest.au. A three-agent audit (competitor teardowns, live-prod
fetch, repo inventory) found the on-page/technical stack already strong —
the real problems were broken freshness signals, unclaimed head terms, and
zero measurement. All three are now fixed (§2). **The remaining gap is
authority/backlinks** — ShortMan and Small Caps outrank on age and links
with objectively weaker pages (ShortMan: no H1, no schema; Small Caps:
canonical points at its own homepage). No code change closes that gap.

### What the winners do (competitor synthesis, 25 July)

- **All four rivals** server-render their data table with a **visible ASIC
  data date** ("Data: 20 Jul 2026").
- **Market Index** (strongest page): live table + full tutorial with
  question-form H2s ("What is Short Selling?", "Why is Short Selling
  Allowed?") on ONE URL.
- **ShortInterest.au** (the modern playbook): FAQPage + Dataset +
  SearchAction JSON-LD, an above-the-fold `<time itemProp>` updated-line,
  auto-generated "where shorts are building / covering" prose, an **ASX T+1
  gross-short-sales blend** ("see short flow 3 days sooner"), and
  /methodology + /editorial-policy trust pages.
- Nobody's title claimed **"most shorted stocks asx"** verbatim — we took it.

---

## 2. Shipped & live-verified (July 2026 wave)

### On-page / schema — PR #349 (live 25 July)

- Homepage title → `Most Shorted ASX Stocks — Official ASIC Short Selling
  Data`; H1 keeps the "Shorting the ASX" phrase that already ranks.
- Visible `ASIC short position data as at <date> (T+4)` freshness stamp on
  the top-10 table (from already-fetched series; handles both proto
  Timestamp and edge-read RFC3339 shapes).
- First-ever homepage links to `/statistics` and `/scans` (previously 0 of
  74 internal links); duplicate H2 removed.
- Homepage FAQ (4 Q&As, question-form headings) + FAQPage JSON-LD — visible
  copy and schema share one source so they can't drift.
- Reports: `datePublished`/`dateModified` on monthly Article (Google drops
  rich results without it); weekly/yearly parity fields.
- `/scans` hub: ItemList JSON-LD + as-of freshness line.
- Stock page: `formatCompanyName()` repairs the backend "Bhp Group" casing
  at display time.
- `noindex` on glossary/news not-found metadata fallbacks.

### Already in place from the 15–16 July stack (PRs #263–#268)

/statistics citation page ($88B headline), /scans (6 registry-driven scan
pages), stock-page ISR + "short interest" titles + indexability gate,
canonical weekly-report slugs + NewsArticle schema, ~4,100-URL sitemap,
/learn (15 articles w/ Article+FAQPage), /glossary (84 DefinedTerms),
/faq (~35 Q&As), robots.txt AI-crawler allowlist, llms.txt.

### Data-integrity fixes (the silent saboteurs)

- **`/statistics` + `/scans` served 19-day-stale data** ("Total Dollars
  Shorted **Today**" datelined 6 July). Root cause: `statement_timeout`
  killed the nightly MV-refresh chain at `mv_screener_data`, starving every
  MV after it. Fixed at both layers (sync-side `SET statement_timeout=0` +
  migration 000095 per-MV guards, applied to prod 27 July); the nightly
  sync now busts the scans/statistics caches directly. A "Today" page
  serving 3-week-old data is a trust signal Google reads via `<time>`.
- **26-July API outage** (secret-version tooling bug, unrelated to SEO
  code): ~3.5h of hard 500s — crawl-time 500s are ranking poison. Resolved
  and structurally prevented
  (`docs/incidents/2026-07-26-internal-service-secret.md`).

### Measurement restored — PR #351 (live 25 July)

GA4 recorded **~zero traffic 16–25 July**: the perf batch's gtag stub
pushed arrays instead of `arguments` into dataLayer, so gtag.js silently
ignored every command while appearing to load. Fixed + regression-pinned.
**Treat 16–25 July as a permanent gap in any GA comparison.**

### Corrections to earlier beliefs (don't re-litigate)

- The audit's "/scans is an empty client shell" was **wrong** — the hub is
  a card index by design; slug pages SSR full tables.
- The staleness was **data-layer** (MV refresh), not ISR/KV caching.
- "Reports lack NewsArticle schema" was **stale** — weekly reports and news
  takes already emitted it; only dates/parity fields were missing.

---

## 3. Next steps (priority order)

| # | Item | Owner | Effort | Notes |
|---|------|-------|--------|-------|
| 1 | **GSC**: resubmit sitemap; request re-indexing of `/`, `/statistics`, `/scans`; baseline the retargeted queries | Ben | ~30 min | GA is clean from 25 July onward |
| 2 | **Authority / outreach**: journalists who cite ShortMan (Livewire, Stockhead, Motley Fool's Mickleboro — uses raw ASIC, no tool loyalty); media kit anchored on the `/statistics` $-shorted citation line; embeddable charts/widgets | Ben (+ drafting help) | M | The #1 lever. Strategy doc Phase 2 |
| 3 | **ASX T+1 gross-short-sales blend** | build | M–L | Parity with ShortInterest.au's freshest-data claim (strategy Phase 3.4). Biggest remaining product differentiator |
| 4 | ~~Auto-generated "shorts building / covering" prose~~ | build | — | **SHIPPED** — `ShortFlowNarrative` on the homepage, prose from the cached 1w movers data (see §5) |
| 5 | ~~Extend crawlable homepage/top list beyond 20 rows~~ | build | — | **SHIPPED** — homepage SSR table now 100 rows via the summary-only RPC (see §5) |
| 6 | **Rotate `GEMINI_API_KEY_NEWS`** | Ben | S | News embeddings silently failing for weeks → degrades related-news internal linking (a crawl-graph signal) |
| 7 | ~~Backend `cleanCompanyName` fix~~ + **metadata resync** | build / Ben | S | Both Go copies now mirror the web `formatCompanyName` (acronyms survive). **Remaining op**: re-run market-data-sync stocklist so stored `company-metadata.company_name` values regenerate |
| 8 | **Google News Publisher Center** registration | Ben | S | Carried from the May wave — still the unlock for Top Stories/News tab; NewsArticle schema is ready |
| 9 | **Sector hubs decision** (`/sectors/*` editorial) | Ben | M | Carried from May (deferred on editorial copy). Note `/industry/[slug]` pages now exist — decide whether to invest editorial there instead |
| 10 | **Watch (2–6 weeks)**: rankings for "most shorted asx stocks" / "asx short selling"; CTR on the new title; whether the freshness stamp earns a SERP date snippet | — | — | Title retargets take 2–6 weeks to settle. **Do not re-tweak titles before then** |
| 11 | Mobile CWV (Lighthouse LCP), YouTube explainers, short-move alerts | later | L | Strategy Phases 3–4 remainder |

---

## 4. Standing landmines (hard-won)

- Dynamic-segment ISR requires `generateStaticParams` to EXIST (even `[]`)
  or `revalidate` is inert.
- `notFound()`/`redirect()` behind a `loading.tsx` boundary fire mid-stream
  → soft-404s. Real 404s belong in `generateMetadata`; real 301s in
  middleware (and matchers need `:slug*`, not `:slug`).
- Edge-read dates are RFC3339 **strings**, not proto Timestamps — every
  consumer must handle both shapes.
- `cache:'no-store'` throws inside `unstable_cache` during static
  generation → use `serverFetchOutsideNextCache`.
- After every deploy, promote resets ISR pages to placeholders — the deploy
  pipeline's post-promote revalidate step must stay green.
- Never import `shorts_pb` in web routes (drags the legacy descriptor into
  the bundle); domain `_pb` modules only.

---

## 5. Tracking (July 2026 wave)

| Item | PR | Shipped |
|---|---|---|
| Head-term retarget + freshness stamp + FAQ + internal links | #349 | 2026-07-25 |
| MV-refresh hardening (staleness root cause) | #349 + migration 000095 | 2026-07-25 / prod-applied 07-27 |
| GA dataLayer `arguments` fix | #351 | 2026-07-25 |
| Announcement-crawler insert-storm fix (DB health) | #350 | 2026-07-25 |
| Secret-cleanup safety (outage prevention) | #363 | 2026-07-27 |
| Roadmap #4 building/covering prose + #5 100-row crawlable table + #7 backend `cleanCompanyName` | TBD | 2026-07-27 |

---

## 6. May 2026 wave (historical — all shipped unless noted)

<details>
<summary>Original Tier 1–4 items + tracking table (last updated 2026-05-17)</summary>

| # | Item | PR | Shipped |
|---|---|---|---|
| 1 | Glossary 26 → 82 terms | #125 | 2026-05-17 |
| 2 | Programmatic sector hubs | — | **still deferred** (see §3 item 9) |
| 3 | sameAs Knowledge Graph anchors | #119 | 2026-05-17 |
| 4 | Google News Publisher Center | — | **still open** (see §3 item 8) |
| 5 | Author byline + /authors | shipped later | `/authors` + Person schema now live |
| 6 | WebSite schema + Sitelinks search | #118, #126 | 2026-05-17 |
| 7 | Insider trades hub | #120 | 2026-05-17 |
| 8 | Report OG images | #121 | 2026-05-17 |
| 9 | preconnect news image CDNs | #126 | 2026-05-17 |
| 10 | llms.txt expansion | #129 | 2026-05-17 |
| 11 | NewsCard CLS fix | #128 | 2026-05-17 |
| 12 | LinkifiedNarrative for weekly reports | #131 | 2026-05-17 |
| 13 | Price + short dual-axis overlay chart | #134 | 2026-05-17 |
| 14 | /data Dataset Hub | #122 | 2026-05-17 |
| 15 | Story clustering on /news | #124 | 2026-05-17 |
| 16 | 5 new ASX news sources | #127 | 2026-05-17 |
| 17 | Googlenews redirect resolver | #123 | 2026-05-17 |

Plus off-roadmap ships that wave: sitemap quality filter + noindex thin
pages (#110), /news + per-stock news (#112), news hero images (#112),
OG-image backfill scheduler (#117), sitemap/robots for new surfaces (#130),
Cloudflare ruleset imports (#132–#133).

</details>

---

PRs landing for roadmap items should link back to this file; update §5 with
ship dates as items close.
