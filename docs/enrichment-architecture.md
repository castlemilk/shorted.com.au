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
│   services/jobs (shorted announcements) ASX announcements → director/divid. │
│   services/report-extractor       financial-report PDF → metrics + digest   │
│   services/signals-collector      NEW: risk/reputation signals              │
│   services/jobs (shorted news)    RSS/news → match → sentiment → embeddings │
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

Consumers in shorted: `shorted news` (rss_fetcher, googlenews_resolve, image_backfill),
`shorted announcements`, `enrichment-processor`, `pkg/enrichment` (logo_discoverer,
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

## 4. Pipeline B — Director trades (`shorted announcements` + `report-extractor`)

1. **Crawl** (`shorted announcements`): per-stock ASX announcement pages (stealth native),
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

## 7. Pipeline E — News + embeddings (`shorted news`)

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

> **Status (2026-06-20, branch `feat/enrichment-uplift`):** §6.3 ✅, §6.5 ✅, §6.9 ✅
> shipped (code + IaC only — prod migrations / `terraform apply` / merge still to run).
> §6.7 **re-scoped & deferred** (the job-monitoring stack was never merged — see §6.7).
> §6.1/§6.2/§6.10 and §6.4/§6.6/§6.8 untouched.
> - **§6.3 ✅** title noise-filter (keeps presentations; statutory keep-overrides for
>   Appendix 4D/4E / "Financial Report" / "Results Announcement") + digest decoupled from
>   metric extraction + `--backfill-digests` mode to recover the ~4,740 existing
>   `digest=NULL` rows (prefers stored GCS text). `test_extract.py` added. (c) not done.
> - **§6.5 ✅** additive `UpdateKeyPeopleIfEmpty` people-only write below the 0.80 gate
>   (env `WRITE_PEOPLE_BELOW_GATE`; never clobbers an existing list; status left pending).
>   The historical 178-stock gap still needs a re-run / pending-people backfill to realise.
> - **§6.9 ✅** signals-collector + report-extractor containerised as scale-to-zero Cloud
>   Run **jobs** (Python, NOT a Go rewrite — deferred to §6.2); `get_stock_signals` chat
>   tool; migration 000069 `director_extract_attempts` failure-budget so the daily director
>   job converges instead of re-burning Gemini on persistent 3Y-PDF failures.

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

### 6.7 Pipeline observability — MED (re-scoped 2026-06-20)
**Correction:** `job_runs` telemetry (migration 000046) is not merely "not applied in prod" —
it is **not in the tree at all**. Migrations jump 000045→000047, and `services/pkg/jobstatus`
is a 71-line **stub** writing to a `job_runs` table no migration creates (schema incompatible
with the real design). The full stack lives only on **unmerged branch `feat/job-monitoring`
(f1b15079)**. So §6.7 is three jobs: (1) land that branch (resolving the stub conflict + ~24-file
store-layer conflicts vs the knowledge-graph work), (2) apply 000046 to prod manually + wire the
still-unwired pipelines (enrichment-processor, signals-collector, report-extractor×3, daily-sync)
+ fix the short-data-sync uvicorn-as-job landmine, (3) build the genuinely-new per-source
freshness + %coverage view that distinguishes real lag from the ASIC **T+4** false alarm.
Deferred: landing an unmerged branch + manual prod migration + prod TF apply deserves its own
focused effort, not a side-quest.

**Superseded (2026-08-22).** Job observability shipped a different way: the admin
console reads Cloud Run executions + Cloud Scheduler directly via
`services/shorts/internal/jobmonitor` (no `job_runs`/`v_job_health` view, no
000046). The orphaned `store.GetJobsOverview()` / `JobHealth` reader for that
never-created view was deleted in the short-data-sync cleanup slice, and
`daily-sync` itself is gone — the ASIC tier is now `shorted short-data-sync` in
the jobs monolith.

### 6.8 Cost-tiering for all AI calls — MED
brandbrain's free-index → cheap-search → DeepSeek → Gemini-grounded ladder vs shorted's
always-LLM enrichment. Adopt a tier-0 cache/heuristic before paid calls across enrichment +
signals + digests.

### 6.9 Productionise the new collectors — MED ✅ (2026-06-20)
Shipped: `signals-collector` + `report-extractor` (two jobs) containerised as scale-to-zero
Cloud Run **jobs** (`terraform/modules/{signals-collector,report-extractor}`, wired dev+prod,
CI build-matrix). Chose **Python containers, not a Go rewrite** — the scripts depend on
Python-only libs (pymupdf/langextract), don't use stealth, and are already concurrent +
incremental + idempotent; Go is best deferred to §6.2's brandbrain/stealth unification.
`get_stock_signals` chat tool added. Failure-budget (migration 000069) lands so the daily
director job converges. **Prod note:** `gemini_secret_exists=false` in prod — the two report
jobs deploy but exit early until `GEMINI_API_KEY` is provisioned in prod Secret Manager.

### 6.10 brandbrain horizontal scale — prerequisite for §6.2
Single DigitalOcean instance 502s above ~2 concurrent grounded calls. Research: scale-out +
a request queue, or a shorted-side rate-limited client, before routing high-volume enrichment
through it.

---

**TL;DR for the next session:** §6.3 / §6.5 / §6.9 are shipped on `feat/enrichment-uplift`
(merge + run the prod migrations 000069 / `terraform apply` / provision prod `GEMINI_API_KEY`
to realise them). The next highest-leverage move is **§6.2 + §6.1** — collapse shorted's
bespoke discovery into brandbrain (over stealth) + adopt stealth's semantic extraction — gated
on **§6.10** (brandbrain must scale first). **§6.7** is now a known bigger lift (land the
unmerged `feat/job-monitoring` branch + prod migration). To *realise* §6.5's coverage gain,
re-run the enrichment batch with `WRITE_PEOPLE_BELOW_GATE=true` (or a pending-people backfill).
