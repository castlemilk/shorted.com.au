# SEO Strategy — July 2026

**Goal:** outrank shortman.com.au / marketindex.com.au / smallcaps.com.au (+ the
micro-aggregator field: shortinterest.au, stocktrack.com.au, asxshort.app,
fintel.io) on ASX short-selling queries, build backlinks/trust, and expand
toward a one-stop shop for ASX stock information.

**Research basis:** 13-agent deep dive on 2026-07-15 — live teardowns of all
competitors, 12-query SERP mapping, prod live-site audit, codebase SEO
inventory, backlink/citation landscape, feature matrix, mobile CWV lab runs,
Cloudflare challenge forensics. Findings below marked **[observed]** were
directly verified; **[inference]** where noted.

---

## 1. Executive summary

We are the deepest free product in the category (full history since 2010,
API/MCP, screener, industry pages, editorial) with the best technical SEO
stack on paper — and we rank #8–10 on every head query, behind a 2013-era PHP
site (shortman) and a field of micro-aggregators. **The gap is not product or
titles; it is (a) authority/citations — we have ~zero editorial backlinks
while shortman is the default journalist citation — and (b) a handful of
live-site defects that waste the assets we already have.**

One proven strength: AI search summaries already cite our live numbers
[observed: AI answers quoted our LOT 22.87%, ORE figures]. Classic rankings
lag badly.

Three plays, in order:

1. **Hygiene (this week):** fix the soft-404 "latest weekly report", the stale
   report generator, the signin nav-link equity leak, battlegrounds
   discoverability, sitemap/feed challenge exemptions.
2. **Win the winnable SERPs (weeks 2–6):** upgrade `/top` into the head-term
   hub; retitle stock pages to "short interest" phrasing and SSR their full
   content; repackage weekly reports to match the query language; launch the
   `/statistics` citation magnet.
3. **Authority (ongoing):** journalist outreach around the statistics page +
   weekly media kit; forum/community presence; academic dataset; embeds.
   Features that broaden the shop (dividends, announcements) come after the
   short-native wins.

---

## 2. Competitive position (verified 2026-07-15)

### shortman.com.au — the incumbent citation
- #1–2 on nearly every head query with a single data homepage. Moat = domain
  age + being the default media citation (Livewire "$25.5B borrowed against
  the top-100", Stockhead Health Check, Money of Mine, Boreham columns).
- Technically hollow [observed]: query-param URLs (`/stock?q=BHP`), **zero
  JSON-LD**, JS-only Top-100 table, charts capped at 3 years, no
  lastmod/dates anywhere, CSV export commented out, no alerts/API/accounts.
  Their #1 "most shorted stock" is ATBHQ — a bond at 100% short (no equity
  filter; our migration 000043 already filters these).
- Their one unique feature: 10-year **price** seasonality pages per stock.
- **Read:** we close this gap with links and citable assets, not features.

### marketindex.com.au — the strongest all-rounder
- Two-pronged [observed]: evergreen `/short-selling` hub (data table + T+4
  education on one URL, #1 for "short selling asx") + weekly **"Short Seller
  Series"** ("The 10 most shorted ASX stocks… week N-2026") with human
  catalyst commentary, full NewsArticle schema, named author (Kerry Sun),
  ~15 ticker links per article. Week-numbered articles take multiple slots on
  freshness SERPs (3 of 10 on "most shorted stocks asx 2026" [observed]).
- One-stop-shop stock pages: live Cboe prices, announcements (each with its
  own indexed URL), dividends, broker consensus, director transactions, top-20
  shareholders, ~28 programmatic scan pages, market-cap rankings.
- **Exploitable holes [observed]:** NO short data on stock pages at all, no
  short time series/history, no per-stock short pages, no JSON-LD on stock
  pages, no API. "{ticker} short interest" is uncontested by them.

### smallcaps.com.au — authority hub, broken execution
- `/shorted-stocks` is a **live tracker page, not a weekly article series**
  [observed — premise correction]: 711 SSR'd rows, sitewide Tools-nav link,
  exact-match slug, "updated daily".
- Ranks despite [observed]: canonical pointing at their **homepage**, generic
  homepage title/meta on the hub, zero JSON-LD anywhere. Pure domain
  authority (12+ named journalists, 100–200 bylined articles/month).
- **Lesson:** one stable, sitewide-linked, fully-SSR'd hub concentrates
  equity. Beatable on technical merit.

### Micro-aggregators (the per-ticker + "short interest" SERP holders)
- **shortinterest.au** [observed]: #1 for "asx short interest". Fresh (updated
  same-day), dual-sources ASIC T+4 **plus ASX T+1 gross short sales** with
  per-row source labels, Δ7d/Δ30d columns, 52-week hi/lo context, ~1,000
  `/ticker/*` pages with ~500 words of templated analysis, /methodology +
  editorial-policy trust pages. No schema. AdSense-run (AussieQuant).
- **stocktrack.com.au** [observed]: ranks #1–2 for per-ticker "{company} short
  interest" queries with data **~7 weeks stale** (26-May data on 15-Jul), no
  sitemap, no schema, no H1. Beatable purely on freshness + title phrasing.
- **asxshort.app**: #1 "short squeeze asx stocks" with a purpose-built
  squeeze-candidates page.

### SERP snapshot (US-localized WebSearch; AU positions likely slightly better for .com.au)
| Query | #1 today | shorted.com.au |
|---|---|---|
| most shorted asx stocks | shortman | **#8** (/top) |
| asx short positions | shortman | #10 |
| asx short interest | shortinterest.au | #9 |
| short selling asx | marketindex /short-selling | absent |
| how to short the asx | marketindex (+2 YouTube slots) | absent (pillar exists!) |
| short squeeze asx stocks | asxshort.app | absent (/battlegrounds exists!) |
| {company} short interest | Smartkarma (paywalled) / stocktrack | absent (1,600 pages exist!) |
| most shorted asx stocks july 2026 | shortman, then dated Fool/MI articles | absent |
| asic short position reports | asic.gov.au | **#5** |
| asx short data | asic/asx raw file | absent |

The pattern: **every page type needed already exists — it's losing on
packaging (titles/slugs), SSR depth, freshness, discovery wiring, and
authority.**

---

## 3. Live-site defects found (fix first — they undercut everything)

1. 🔴 **`/reports/weekly/2026-W28` is a sitemapped, index-promoted soft-404**
   [observed]: the /reports index promotes "Latest weekly report · Week 28"
   but the URL returns HTTP 200 + `noindex` + client-rendered "Page Not
   Found" (1.7k chars of nav/footer SSR). W27 is healthy (12.2k chars,
   Article+ItemList+Dataset schema). Also: **latest live weekly is W25 —
   today is W29. The Friday generator has apparently not published for ~3
   weeks** [observed W25 latest; staleness cause = inference, investigate the
   Cloud Run job]. Freshness is the entire game on the weekly SERPs.
   - Guard: never link/sitemap an unpublished report slug; unpublished →
     hard 404.
2. 🔴 **Stock pages are thin to crawlers + uncached** [observed]:
   `/shorts/PLS` SSRs only ~2.8k chars (narrative sentence + description + 3
   stats). Peers/financials/news content is entirely client-fetched — absent
   even from the RSC payload. Headers: `private, no-cache, no-store`, Vercel
   cache MISS on every hit → all ~1,642 stock pages re-SSR per crawl hit.
   This is the highest-volume winnable cluster (per-ticker short interest)
   and our pages give Google the least HTML in the field.
3. 🟠 **Sitewide nav "industry intel" href = `/signin?callbackUrl=%2Findustry-intelligence`**
   [observed] — sitewide internal equity pointed at a signin URL.
4. 🟠 **`/battlegrounds` (squeeze radar) is shipped but invisible** [observed]:
   merged to origin/main with full metadata/canonical, but absent from
   sitemap.ts, robots AI_ALLOWED_PATHS, and llms.txt. The "short squeeze asx"
   SERP has weak incumbents.
5. 🟡 **Cloudflare challenge on sitemap.xml + feed.xml** [observed +
   forensics]: source is **Super Bot Fight Mode zone settings set in the
   dashboard, NOT Terraform** (`sbfm_definitely_automated: managed_challenge`,
   `sbfm_verified_bots: allow`). Verified Googlebot/Bingbot/GPTBot/ClaudeBot
   are exempt (allow + corroborated by fresh indexation), so this is NOT a
   Googlebot blocker — but `.xml` isn't on CF's static-extension list, so
   **RSS is dead to every non-verified feed reader**, and **PerplexityBot was
   de-verified by Cloudflare (Aug 2025) so it likely hits the challenge**
   despite our robots.txt invitation. Also a TF drift risk: a dashboard flip
   of `sbfm_verified_bots` to block would be invisible to `terraform plan`.
6. 🟡 **Mobile CWV is bad in lab** [observed, Lighthouse mobile]: LCP 13.9s
   (home), 5.2s (/shorts/BOE), 12.7s (learn pillar), 12.3s (weekly report).
   Cause = render delay (render-blocking CSS ~1.9s + ~62 scripts/1.2MB JS),
   not TTFB. CrUX has **no field data** for the origin (first appeared
   2026-06, below sample threshold) → CWV is currently a *neutral* ranking
   signal, so this is a UX/future-proofing item, not an emergency. shortman
   passes all CWV; marketindex fails CLS.
7. 🟡 Discovery-file drift [observed]: `ai.txt` stale since 2026-01 (missing
   housing/reports/battlegrounds/MCP); llms.txt missing /battlegrounds,
   /features/the-widow-maker, /market/[date], /seasonality, /authors;
   `/housing/suburbs` hub orphaned from sitemap; only 20 /news URLs
   sitemapped despite ~daily editorial; learn-article list hand-maintained
   (has drifted before); compare-pair coverage arbitrary (30 alphabetical).

---

## 4. Keyword & content plays

### 4.1 Head terms — upgrade `/top` in place (do NOT launch a new URL)
`/top` already ranks #8 for "most shorted asx stocks" — it is our one ranking
head-term asset. Launching a parallel `/most-shorted` would split equity.
Instead:
- Retitle/re-H1 `/top`: "Most Shorted ASX Stocks — Live ASIC Short Positions"
  with "short interest" phrasing in H2s/copy (the term is shifting toward US
  usage [observed: shortinterest.au #1, "asx short interest" cluster]).
- Full SSR table (top 100+, all rows crawlable links to `/shorts/[code]`),
  dated "as of {ASIC date}", Δ1w/Δ1m columns, days-to-cover.
- **Sitewide nav link** (the Small Caps lesson: one stable URL + sitewide
  anchor). Dataset + ItemList schema.
- Optional later: `301 /most-shorted → /top` alias for exact-match anchors.

### 4.2 Per-ticker long tail (~1,600 pages) — the biggest volume gap
Incumbents: paywalled Smartkarma and 7-weeks-stale stocktrack. We win on
freshness + depth if the pages actually expose it:
- **Title retarget** (critic-verified: current title says "Short Position",
  only the sr-only H1 says "Short Interest"): →
  `{CODE} Short Interest — {Company} (ASX:{CODE}) | {X.XX}% Shorted | Shorted`.
  Keep the live % (it's a proven freshness signal in our indexed titles).
- **SSR the tabs** (peers, financials summary, recent news headlines) into
  HTML — content exists, it's client-only today. Add 52-week short-interest
  range + Δ7d/Δ30d (match shortinterest.au's context, beat their 500-word
  template with our narrative + full history).
- **Drop `no-store` → ISR** (revalidate ~1h; bust via existing
  /api/revalidate on daily sync). Crawl economics across 1,642 URLs matter.
- Internal links: /top table rows + weekly report mentions → stock pages
  (hub-and-spoke like Market Index).

### 4.3 Weekly freshness SERPs — repackage the reports
Market Index's series + Motley Fool's dated posts own "most shorted… this
week / {month year}". We have the pipeline (weekly LLM reports) but the
packaging loses:
- Human-readable slug alias: `/reports/weekly/10-most-shorted-asx-stocks-week-29-2026`
  (canonical) with `2026-W29` 301'd or kept as alt — title
  "The 10 Most Shorted ASX Stocks — Week 29, 2026".
- NewsArticle schema + named author entity (authors page exists), publish
  Monday morning (MI publishes Mon [observed once — inference]), and
  event-attribution commentary (broker moves, guidance) — our generator's
  quality gate should demand catalyst attribution like MI's human commentary.
- **Fix the generator staleness first** (§3.1) — a weekly series that skips
  weeks can't win freshness SERPs.
- Wire the series into feed.xml (already) + llms.txt + a "This week" module
  on /top and the homepage.

### 4.4 "Short squeeze asx" — ship /battlegrounds discovery
Weak incumbents (asxshort.app + a wrong-entity NYSE site). Actions: add to
sitemap/llms.txt/ai.txt/robots AI paths, retitle toward "ASX Short Squeeze
Candidates", add a **methodology section** (deep-linkable citation asset),
internal links from /top + stock pages. Consider `/short-squeeze` 301 alias.

### 4.5 "How to short the asx" — the pillar exists, it's isolated
14.2k chars, FAQPage schema, fresh — but absent from the SERP. It needs
internal anchors (from /top, homepage, stock pages, weekly reports) and
external links (§5). YouTube holds 2–3 slots: two cheap explainer videos
(chart walkthrough + T+4 explainer) embedding the pillar link would capture
video-pack real estate.

### 4.6 "asx short data" / API intent — harden /data
Position as "Download every ASIC short position, 2010→today" (CSV + API +
suggested-citation block). A hobby page currently ranks. This doubles as the
academic backlink asset (§5.6).

### 4.7 /statistics — the citation magnet (new page)
Server-rendered, dated: "**$X.XB is currently short-sold on the ASX**", bank
basket (we already have BankShortBasket), sector baskets, weekly movers,
total-$ history chart. The `api/about/statistics/route.ts` endpoint already
computes aggregates — there is **no indexable surface** for the exact stat
journalists cite shortman for (whose number lives only inside a JS chart).
Pre-written citable sentences + "embed this chart" + CSV download.

---

## 5. Trust & backlink plan (ranked value/effort)

Current state [observed]: external citations of shorted.com.au ≈ two GitHub
repos. shortman owns the media citation pattern.

1. **/statistics + journalist outreach** (Low effort / High value). Pitch the
   exact people who currently cite shortman: Livewire contributors, Stockhead
   Health Check, Money of Mine, Tim Boreham. Hook: crawlable dated stat +
   embeddable chart + full history (shortman: JS-only chart, 3y cap).
2. **Monday media kit** (Low / High, compounding). Weekly email: top-10 +
   movers + per-stock history chart links + CSV. Primary target: Motley Fool
   AU's James Mickleboro (writes weekly from raw ASIC with no tool loyalty).
3. **Full-history angle in communities** (Low–Med / Med-High). Strawman
   complaint observed about shortman's 3-year cap (single data point — don't
   oversell). Genuine participation on Strawman/HotCopper/Reddit with
   full-history chart links; add "embed this chart" buttons to make sharing
   produce links.
4. **/battlegrounds methodology page** (Low / Med) — citable reference for
   squeeze listicles (Livewire has published these).
5. **"Best ASX tools" listicle pitches** (Low / Med). Verify each listicle
   actually lacks a short-data tool before pitching (our recon inferred, not
   confirmed, for macrogmsecurities).
6. **Academic dataset** (Med / Med, durable). PBFJ/Monash authors
   hand-assemble ASIC CSVs today. Cleaned bulk download + suggested citation
   on /data; email authors of the three papers identified.
7. **T+1 gross short sales overlay** (Med / Med). NOTE: this achieves
   **parity** with shortinterest.au (their differentiator), not uniqueness —
   worth doing for freshness (T+1 vs T+4) and citation completeness.
8. **Skip:** Wikipedia self-citation (revert risk). At most contribute
   ASIC-cited short-reporting history to the ASX article.

---

## 6. Feature roadmap — "one-stop shop"

Feature matrix headline [verified]: Market Index is the incumbent via scans +
announcements + dividends + broker consensus; the short-data specialists are
shallow beyond shorts; **nobody free offers short-change alerts or an API**
(both already ours).

Ranked (SEO value / differentiation / effort):

1. **Short-crossover scan pages** (H/H/**L**) — "most-shorted at 52-week
   lows", "shorts covering into strength", "short interest risers", plus
   plain movers/52-week pages. Computed entirely from existing
   `shorts` + `stock_prices` + screener MVs. MI's proven scan playbook with a
   twist nobody has. Each = daily-fresh indexable URL.
2. **Watchlist + email alerts on short-position moves** (–/H/L–M) — nobody
   free does this (Fintel paywalls it). Auth, Resend infra, watchlist MV,
   daily-sync trigger all exist. Retention moat + Premium hook + gives
   journalists a reason to live on the site.
3. **Short-position seasonality per stock** (M/M/L) — neutralizes shortman's
   only unique feature (price seasonality) and goes one better with short
   seasonality. Extends existing /seasonality.
4. **Dividend calendar + per-stock dividend history/yield** (H/L/M) — highest
   raw query volume of any gap; ~1,600 new URLs + a module on every stock
   page. Needs a corporate-actions source (EOD provider or ASX). Table
   stakes, not moat — do after short-native wins.
5. **Announcements with AI summaries + short-reaction annotation** (H/H/M–H)
   — "shorts rose 1.2pp in the 4 days after this downgrade". The
   differentiated version of MI/HotCopper's traffic engine. **Risk is ASX
   licensing (20-min delay + redistribution terms), not the build.** Scope
   the licensing before committing.
6. **Publicize /embed/chart widgets** (indirect/–/trivial) — "embed this
   chart" buttons; every embed is a backlink.
- **Deprioritize:** broker consensus (licensing cost, low diff), ETF pages
  (we filter ETFs by design), portfolio tracking + forums (CommSec/HotCopper
  moats, no SEO surface).

---

## 7. Phased roadmap

### Phase 0 — Hygiene (week 1) — all code/config, no new surfaces
| # | Action | Where |
|---|---|---|
| 0.1 | Fix W28 soft-404: unpublished report → hard 404, exclude from index page + sitemap | `web/src/app/reports/**`, sitemap.ts |
| 0.2 | Diagnose + fix weekly-report generator staleness (W25 last published, now W29) | `services/weekly-report-generator/`, Cloud Run job + scheduler |
| 0.3 | Fix nav industry-intel link → `/industry-intelligence` (no signin bounce) | nav component |
| 0.4 | Wire /battlegrounds into sitemap.ts + llms.txt + ai.txt + robots AI paths | sitemap.ts, `web/public/*` |
| 0.5 | CF: codify SBFM settings in TF (`cloudflare_bot_management`), add skip/exemption for `/sitemap.xml` + `/feed.xml`; decide PerplexityBot stance | `terraform/modules/cloudflare-edge/` |
| 0.6 | Discovery-file refresh: ai.txt, llms.txt additions, /housing/suburbs into sitemap, learn-article list imported from source of truth, raise /news sitemap coverage | sitemap.ts, public files |

### Phase 1 — Winnable SERPs (weeks 2–6)
| # | Action |
|---|---|
| 1.1 | `/top` upgrade: retitle, full SSR table, Δ columns, days-to-cover, as-of date, sitewide nav link, Dataset/ItemList schema |
| 1.2 | Stock pages: "short interest" title retarget + SSR peers/financials/news + 52wk short range + Δ7d/Δ30d + ISR (drop no-store) |
| 1.3 | `/statistics` citation page (total $ shorted, baskets, movers, embed + CSV) |
| 1.4 | Weekly report repackage: human-readable slugs, NewsArticle schema, author entity, Monday publish, catalyst-attribution quality gate |
| 1.5 | /battlegrounds: squeeze retitle + methodology section + internal links |
| 1.6 | Internal-link mesh: /top ↔ stock pages ↔ weekly report ↔ pillar ↔ /statistics |

### Phase 2 — Authority (weeks 4–12, overlapping)
| # | Action |
|---|---|
| 2.1 | Journalist outreach wave 1 (statistics page launch hook) — Livewire, Stockhead, Money of Mine, Boreham |
| 2.2 | Monday media kit (automate from weekly report data; Resend broadcast infra exists) |
| 2.3 | Embed buttons on charts; community participation (Strawman/HotCopper/Reddit) |
| 2.4 | /data research dataset + academic outreach |
| 2.5 | 2 YouTube explainers targeting "how to short the asx" video pack |
| 2.6 | Listicle pitches (verify inclusion gap first) |

### Phase 3 — One-stop-shop expansion (months 2–4)
| # | Action |
|---|---|
| 3.1 | Short-crossover scan pages (first — lowest effort, unique) |
| 3.2 | Watchlists + short-move email alerts |
| 3.3 | Short-position seasonality |
| 3.4 | T+1 gross short sales overlay (parity with shortinterest.au) |
| 3.5 | Dividends (needs data-source decision) |
| 3.6 | Announcements + AI summaries (needs ASX licensing scoping first) |

### Phase 4 — Performance (parallel, opportunistic)
Mobile LCP 5–14s lab: render-blocking CSS + 1.2MB JS. No CrUX field data yet
so not ranking-critical today, but fix before the traffic arrives (it becomes
a ranking factor once field data exists): defer non-critical CSS, cut the
62-script payload, budget in CI (Lighthouse assertions exist in the Storybook
perf bench).

---

## 8. Measurement

| Metric | Baseline (Jul 2026) | 3mo | 6mo | 12mo |
|---|---|---|---|---|
| "most shorted asx stocks" rank | #8 | top 5 | top 3 | #1–2 |
| "asx short interest" rank | #9 | top 5 | top 3 | top 3 |
| Per-ticker "{co} short interest" (sample of 10 heavily-shorted) | absent | 5/10 in top 10 | 8/10 top 5 | own the cluster |
| Referring domains (editorial) | ~2 | 10 | 25 | 60+ |
| Media citations ("according to shorted.com.au") | 0 | 2 | 6/qtr | default citation |
| GSC indexed /shorts pages | ~1,600 submitted | 80% indexed | 90% | 95% |
| CrUX field data | none | present | LCP<2.5s p75 | all green |
| Weekly report publish streak | broken (W25) | 100% on-time | — | — |

Ops cadence: GSC weekly (coverage + query report), rank spot-checks via
incognito/AU VPN monthly, backlink check (Ahrefs free/GSC links) monthly.

---

## 9. Research confidence notes (from adversarial review)

- Stock-page **titles** do NOT currently use "short interest" (only the
  sr-only H1 does) — title retargeting is a real, open lever.
- `/top` already exists and ranks — that's why §4.1 upgrades it in place
  rather than launching `/most-shorted` (equity split risk).
- T+1 overlay = parity with shortinterest.au, not uniqueness.
- Strawman "3-year cap" complaint = one user, one thread.
- MI Monday cadence inferred from a single sample (Week 29).
- Small Caps: "no current weekly short series" is verified for sampled
  sitemap months; a 2021 squeeze article exists.
- macrogmsecurities listicle "no short tool listed" = inference from summary;
  verify before pitching.
- SERP positions are US-localized WebSearch; AU-localized positions likely
  slightly better for .com.au domains (including ours).
- Cloudflare challenge does NOT block verified Googlebot/Bingbot/GPTBot/
  ClaudeBot (`sbfm_verified_bots: allow` + fresh indexation observed);
  PerplexityBot (de-verified Aug 2025) and non-verified feed readers ARE
  affected.
