# Enrichment & Intelligent-Crawler Architecture

> How Shorted turns raw ASX data into a per-stock knowledge graph, traced across the
> three-repo stack **`shorted` → `brandbrain` → `stealth`**, with a prioritised set of
> research areas. Last reflected: 2026-06-19 (after the director / signals / report /
> key-people backfills).

## 1. The three-repo stack

```
┌──────────────────────────────────────────────────────────────────────────┐
│ shorted (this repo) — the product + data pipelines                         │
│   services/enrichment-processor   bespoke 6-phase company enrichment        │
│   services/asx-announcement-crawler  ASX announcements → director/dividend  │
│   services/report-extractor       financial-report PDF → metrics + digest   │
│   services/signals-collector      NEW: risk/reputation signals              │
│   services/news-aggregator        RSS/news → match → sentiment → embeddings │
│   services/pkg/stealthhttp        thin wrapper over the stealth engine      │
└───────────────┬───────────────────────────────┬───────────────────────────┘
                │ HTTP (Connect JSON)            │ import (go.mod)
                ▼                                 ▼
┌──────────────────────────────────┐   ┌────────────────────────────────────┐
│ brandbrain (api.brandbrain.dev)  │   │ stealth (github.com/skunkworq/...)  │
│   AI company/brand discovery     │   │   fetch engine                       │
│   DiscoverBusiness               │   │   native (uTLS fingerprint, no JS)  │
│   ResolveBusinessSignals         │──▶│   chromium/firefox/webkit (JS)       │
│   cost-tiered (free→Gemini-grnd) │   │   waterfall escalation, evasion FSM, │
│   grounded w/ citations          │   │   RL policy, CF auto-solve,          │
└──────────────────────────────────┘   │   semantic.HTMLToSemanticTree (LLM) │
                                        └────────────────────────────────────┘
```

- **`stealth`** is the shared fetch substrate. Both `shorted` (via `pkg/stealthhttp`) and
  `brandbrain` import it. `shorted` pins **v0.4.0**, `brandbrain` pins **v0.5.2** (drift —
  see research §6.6).
- **`brandbrain`** is a deployed *service* shorted calls over the network. Today only
  `signals-collector` uses it; the big `enrichment-processor` does **not** (it reimplements
  discovery — the core duplication this doc flags).

## 2. The fetch layer — `stealth` via `pkg/stealthhttp`

`services/pkg/stealthhttp/client.go` wraps `stealth/brws/engine`:
- `New()` → **native** engine: uTLS TLS/JA3 fingerprint spoof, HTTP/2, no browser, ~10ms. Default for static HTML / PDFs / APIs.
- `NewChromium()` → **chromium** engine: JS render + challenge solving. Used for LinkedIn logo discovery only.
- Options: `WithTimeout`, `WithTLSProfile`, `WithProxy`, `WithMaxRedirects`, `WithExecPath`.
- OTel-instrumented: `shorted.stealth.fetch_{duration,total,errors,bytes}`.

Consumers in shorted: `news-aggregator` (rss_fetcher, googlenews_resolve, image_backfill),
`asx-announcement-crawler`, `enrichment-processor`, `pkg/enrichment` (logo_discoverer,
linkedin_person_client, report_crawler, utils).

**Not yet used by shorted:** the waterfall auto-escalation, evasion FSM / RL policy,
Cloudflare auto-solve, and — most importantly — `semantic.HTMLToSemanticTree` (LLM
hierarchical extraction with ~99% token compression). See research §6.1.

## 3. Pipeline A — Company metadata enrichment (`enrichment-processor`)

The bespoke 6-phase pipeline. Entry: `runEnrichmentPhases()` (`main.go:593`). One stock at a time.

| Phase | What | External call | Timeout |
|---|---|---|---|
| 0 Website discovery | find official site if missing | `gptClient.DiscoverWebsite` (OpenAI/Gemini) | 60s |
| 1 Metadata scrape | leadership / about / key links | `metadataScraper.ScrapeMetadata` (stealth native + **Chromium** fallback) | 90s |
| 2 Report crawl | discover financial-report PDFs on site | `reportCrawler.CrawlFinancialReports` (stealth) | 60s |
| 3 LLM enrichment | summary/history/risks/people/tags | `gptClient.EnrichCompany` (**OpenAI gpt-5.2** or Gemini) | 4m |
| 3a Fallback people | only if LLM returned 0 people | **Yahoo Finance officers** + deep crawl + LLM | 2m |
| 3.5 Person enrichment | photos + LinkedIn for top people | Yahoo, **LinkedIn (Chromium / Exa)**, Wikipedia, GCS upload | 90s |
| 4 Logo discovery | logo variants + processing | `logoDiscoverer` (**Chromium**) + Python `logo_processor.py` | 2m |
| 5 Quality eval | score 0–1, warnings | `gptClient.EvaluateQuality` | 60s |

**Write gate (CRITICAL):** `main.go:543` — enrichment is auto-approved (written to the
served `company-metadata` fields) **only if `quality.OverallScore >= AUTO_APPROVE_THRESHOLD`
(default 0.80)**. Below that it is staged, not served.

**Run modes:** `RUN_MODE=batch` (one-shot, `BATCH_PRIORITY=short_position|stale|unenriched`,
`BATCH_SIZE`, `BATCH_CONCURRENCY`); HTTP push (Pub/Sub, single stock); `--backfill-people`
(images only — **skips zero-people stocks**, `backfill_people.go:74`); `--backfill-images`.
Needs `APP_STORE_POSTGRES_*` (not `DATABASE_URL`), `OPENAI_API_KEY`. **Not currently deployed**
in prod (removed after a min-instance cost incident) — run locally against prod.

**Selection landmine:** `GetTopStocksForEnrichment` (`postgres.go:1434`) — `short_position`
priority has *no* completed-filter (selects all top-shorted) but the processor then *skips*
already-completed stocks (`"already enriched, use force=true"`); `unenriched`/`stale` filter
on status/date. There is **no "missing key_people" selector** — targeting that gap requires a
status reset first.

## 4. Pipeline B — Director trades (`asx-announcement-crawler` + `report-extractor`)

1. **Crawl** (`asx-announcement-crawler`): per-stock ASX announcement pages (stealth native),
   HTML-parse Appendix 3Y headlines → `director_trades`. Headlines carry **no name in ~59% of
   cases and never carry $ value** → historically dirty (see [director-data-extraction memory]).
2. **PDF extraction** (`report-extractor/extract_director_trades.py`, NEW): fetch each 3Y PDF,
   gemini-2.5-flash structured extract (name, securities, consideration, direction) → write
   back keyed on `announcement_url`. Concurrent, idempotent.

**Reflection (2026-06-19 backfill):** of 21,291 unique 3Y PDFs — **ok 7,644 / no_extract 13,398**.
By year: 2026 75% extracted, 2025 31%, **2024 ~0.1%** → older ASX announcement PDF URLs do not
resolve/download (archived differently or expired). See research §6.4.

## 5. Pipeline C — Risk / reputation signals (`signals-collector` → brandbrain) — NEW

The first true `shorted → brandbrain → stealth` integration.
`services/signals-collector/collect.py` → POST `brandbrain.v1.DiscoveryService/ResolveBusinessSignals`
`{business_name, state}` → brandbrain runs Gemini-grounded research (over stealth) → returns
`adverse[]` (court/sanction/complaint/safety, severity, citations) + `positive[]` (awards/press).
Upsert `stock_signals` (idempotent via `content_hash`). Served by `GetStockSignals` RPC →
Overview "Risk & reputation" card.

**Reflection:** 150 top-shorted swept → **2,027 signals / 192 stocks / 205 high-severity**.
brandbrain **502s above ~2 concurrent** (single instance) — collector retries 5xx w/ backoff.
This is the model for the rest of enrichment (research §6.2).

## 6. Pipeline D — Financial digests (`report-extractor`)

`extract.py` (+ NEW concurrent `extract_reports_concurrent.py`): select latest-N key financial
reports per company → fetch PDF (pymupdf) → **langextract** structured metrics → gemini-2.5-flash
**digest** → `financial_report_extractions` (+ raw text to GCS). Served by
`GetStockFinancialHighlights` → Financials "Results summary" card.

**Reflection (4,817-report backfill):** **ok 71 / no_metrics 4,740 (98%)**. Metric-hit by type:
half_year 6.7%, annual_report 3%, annual_results 13%. Root cause: the crawler classifies *any*
"half year"/"annual" announcement as a report, so the set is dominated by **presentations,
media releases and CEO letters** (no metric tables), and the digest is **gated on metrics being
found**. Digests grew 46→115. See research §6.3.

## 7. Pipeline E — News + embeddings (`news-aggregator`)

RSS + Google News (stealth) → stock match → gemini-2.0-flash sentiment → `news_articles` →
gemini-embedding-001 (MRL-768) embeddings → HNSW related-news + company-summary `similar_to`
edges. (See stock-intelligence-panel memory; healthy — news fresh daily.)

## 8. Current-state assessment (post-backfill coverage)

| Surface | Coverage | Notes |
|---|---|---|
| director_trades clean names | 13,211 / 21,291 | +$value on 5,352; 2024 URLs fail |
| risk signals | 192 stocks / 2,027 signals | top-shorted swept |
| financial digests | 115 stocks | low metric-hit; presentation noise |
| top-shorted w/ key_people | 624 / 802 | **gate-limited** — Yahoo officers score ~0.74 < 0.80 |
| key_people overall | ~38% | enrichment-processor not deployed |
| asx_announcements | 0 → fills next crawl | `-all-announcements` enabled |

**The core architectural finding:** `enrichment-processor` Phases 0/1/2/3.5/4 (website, metadata,
report-discovery, social, logo) **duplicate brandbrain's `DiscoverBusiness`**, but with bespoke
Chromium scrapers, no cost-tiering, no grounding/citations, and an OpenAI dependency — while
brandbrain (already deployed, already over stealth) does the same with a free→grounded cost
ladder and citations. Shorted runs *two* discovery stacks; only one is intelligent.

## 9. Research & improvement areas (prioritised)

### 6.1 Adopt stealth's `semantic` extraction across crawlers — HIGH
Replace brittle CSS-selector scraping (metadata_scraper, report_crawler, 3Y/report parsers)
with `stealth/brws/semantic.HTMLToSemanticTree` (LLM hierarchical extraction, ~99% token
compression). Research: token/cost vs accuracy vs current selectors; one pilot on
metadata_scraper.

### 6.2 Route discovery through brandbrain (unify the two stacks) — HIGH
Migrate enrichment Phase 0/1/4 to `brandbrain.DiscoverBusiness` (website, logo, social,
industry, HQ, contact — grounded, cost-tiered). Keep shorted-specific phases (financial
reports, people). Removes the Chromium + OpenAI-discovery duplication. Research: field-by-field
quality parity vs current enrichment; brandbrain throughput (it 502s >2 concurrent — needs
horizontal scale or a queue first).

### 6.3 Fix the financial-digest hit-rate — HIGH
(a) Tighten report selection to actual statements (Appendix **4D/4E**, "Financial Report",
"Results Announcement") and exclude presentations/letters/media releases by title regex.
(b) **Decouple the digest from metric extraction** — generate the gemini digest from raw PDF
text even when langextract finds no structured table (a presentation still summarises well).
(c) Evaluate gemini structured-output (like the 3Y extractor) vs langextract for metric tables.

### 6.4 Recover 2024 director PDFs — MED
2024 3Y URLs fail ~100%. Research: ASX archive URL format/expiry; re-resolve via
`displayAnnouncement.do` → `announcements.asx.com.au`; or re-crawl 2024 to refresh URLs.

### 6.5 Decouple key_people writes from the 0.80 quality gate — MED
Yahoo-officer enrichments score ~0.74 (flagged "generic finance profile") and are therefore
**not written**, so the people backfill underdelivers. Research: a separate, lower bar for
*people-only* writes; or score people independently of the whole-company score; or trust
Yahoo officers as a structured source bypassing the LLM-quality gate.

### 6.6 Align stealth versions — LOW/MED
shorted v0.4.0 vs brandbrain v0.5.2. Bump shorted to v0.5.x to share evasion-FSM / RL /
waterfall improvements and avoid two engine behaviours. Mind the `go.work` replace + Docker
bind-mount pattern.

### 6.7 Pipeline observability — MED
`job_runs` telemetry (migration 000046) is **not applied in prod**, so staleness/coverage gaps
are invisible (this is why the financial/people gaps lingered). Apply it + wire every
pipeline + a coverage dashboard (per-source freshness + % coverage). Distinguishes real lag
from the ASIC **T+4** false-alarm.

### 6.8 Cost-tiering for all AI calls — MED
brandbrain's free-index → cheap-search → DeepSeek → Gemini-grounded ladder vs shorted's
always-LLM enrichment. Adopt a tier-0 cache/heuristic before paid calls across enrichment +
signals + digests.

### 6.9 Productionise the new collectors — MED
`signals-collector`, `extract_director_trades`, `extract_reports_concurrent` are run manually.
Port to Go Cloud Run **jobs** on schedulers (mind brandbrain concurrency limits), incremental
(skip-fresh) by default. Add a `get_stock_signals` chat tool.

### 6.10 brandbrain horizontal scale — prerequisite for §6.2
Single DigitalOcean instance 502s above ~2 concurrent grounded calls. Research: scale-out +
a request queue, or a shorted-side rate-limited client, before routing high-volume enrichment
through it.

---

**TL;DR for the next session:** the highest-leverage move is **§6.2 + §6.1** — collapse
shorted's bespoke discovery into brandbrain (over stealth) and adopt stealth's semantic
extraction — but it's gated on **§6.10** (brandbrain must scale first). Quick wins available
now: **§6.3** (digest decoupling — recovers the 4,740 no-metric reports) and **§6.5** (people
write-gate — unlocks the discovered-but-unwritten leadership).
