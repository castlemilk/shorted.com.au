---
name: weekly-reports
description: Operate and improve the Shorted weekly/monthly/yearly short-selling report pipeline — run the generator, iterate on prompts safely, debug quality-gate failures, extend the data snapshot, and keep the generator↔proto JSON contract intact. Use when generating/regenerating reports, tuning report prompts, adding fields to the report snapshot, or debugging /reports pages.
---

# Shorted Report Pipeline (weekly / monthly / yearly)

Operating manual for `services/weekly-report-generator/` (Cloud Run job → `weekly_reports` table) and the read path in `services/shorts/` (`GetWeeklyReport` / `ListReports`) → `web/src/app/reports/`.

## 1. Architecture

```
Cloud Run job: weekly-report-generator (Go, flags -week/-month/-year)
  → DataCollector / MonthlyDataCollector / YearlyDataCollector
    (shorts + stock_prices + company-metadata + announcements + financial reports)
  → buildSnapshot (snapshot.go: movers v2 significance ranking, z-scores,
    streaks, days-to-cover, new-entrant flags, market breadth, industry breakdown)
  → TrendAnalyzer (trend_analyzer.go: pattern insights fed into the prompt)
  → LLM synthesis (llm_generator.go + prompts.go: two-pass multi-model — see §4)
  → QualityChecker (quality_checker.go: programmatic gates + Gemini review, best-of-N retries)
  → weekly_reports row (JSONB columns: top_shorted, risers, fallers, market_stats,
    industry_breakdown, narrative, faqs, citations, trend_insights)
  → [on publish] broadcasts draft row (broadcast_draft.go) + Next.js tag revalidation
```

Read path:

- `services/shorts/internal/services/shorts/weekly_report.go` — `GetWeeklyReport(week_slug)`: **json.Unmarshal's the JSONB columns DIRECTLY into generated proto structs**, then `hydrateWeeklyReportBranding` sets `logo_url` on every stock/mover (always) and backfills `industry` (only when the stored snapshot left it empty) via one `GetCompanyBranding` lookup.
- `services/shorts/internal/services/shorts/list_reports.go` — `ListReports(report_type, limit)`: archive index. Store method in `internal/store/shorts/postgres_reports.go` (published-only, `ORDER BY report_date DESC`, limit default 24 / cap 100).
- Server actions: `web/src/app/actions/reports/getReportData.ts` (`getWeeklyReportData`, `getMonthlyReportData`, enhanced narrative fetch, `getReportsList`). All `unstable_cache`-tagged (see §7).
- Pages: `web/src/app/reports/page.tsx` (index) + `reports/weekly/[slug]`, `reports/monthly/[slug]`, `reports/yearly/[slug]`.

**One table, one RPC family, three report types.** Weekly/monthly/yearly all live in `weekly_reports` keyed by `week_slug`; the **slug shape disambiguates**: `2026-W23` = weekly, `2026-05` = monthly, `2025` = yearly (`reportTypeFromSlug` in `list_reports.go`; same regexes in the store's ListReports filter).

## 2. THE JSON NAMING CONTRACT (the #1 landmine)

`GetWeeklyReport` does `json.Unmarshal(jsonbColumn, &protoStruct)`. Generated proto structs carry **snake_case proto-field-name json tags**. Therefore every struct the generator marshals into a JSONB column MUST use exactly those snake_case tags — a mismatched tag silently drops the field on read (no error, just zero values in the API).

Exact tag sets (defined in `services/weekly-report-generator/data_collector.go`, mirroring `proto/shortedapi/shorts/v1alpha1/shorts.proto`):

| Struct → proto message | Tags |
|---|---|
| `TopStock` → `WeeklyReportStock` | `rank, code, name, short_pct, wow_change, days_to_cover, is_new_entrant, industry, history` (`omitempty`) |
| `Mover` → `WeeklyReportMover` | `code, name, current_pct, previous_pct, change, days_to_cover, z_score, streak_weeks, industry, history` (`omitempty`)`, significance` |
| `MarketStats` → `WeeklyMarketStats` | `total_stocks_shorted, avg_short_pct, max_short_pct, max_short_code, wow_avg_change, median_short_pct, stocks_above_10pct, stocks_above_5pct, riser_count, faller_count` |
| `IndustryStat` → `WeeklyIndustryStat` | `industry, avg_short_pct, wow_change, stock_count, top_stock_code, top_stock_pct` |

`logo_url` is **deliberately absent** from the generator structs — it is hydrated at READ time only (§7).

**Enforced by** `services/weekly-report-generator/json_contract_test.go` (`TestTopStockJSONContract`, `TestMoverJSONContract`, `TestIndustryStatJSONContract`, `TestMarketStatsJSONContract`, `TestHistoryOmittedWhenEmpty`). If you add a proto field to any of these messages: `cd proto && buf generate`, add the matching snake_case-tagged field to the generator struct, and extend the contract test. All three steps or the field never round-trips.

## 3. Running it

```bash
cd services
export DATABASE_URL=postgresql://admin:password@localhost:5438/shorts   # local dev DB
# LLM keys optional — without OPENAI_API_KEY a data-only report is stored (no narrative)
export OPENAI_API_KEY=$(grep '^OPENAI_API_KEY' ../.env | cut -d= -f2-)
export GEMINI_API_KEY=$(grep '^GEMINI_API_KEY' ../.env | cut -d= -f2-)

go build -o /tmp/wrg ./weekly-report-generator/ && /tmp/wrg -h   # NOTE: bare `go build ./weekly-report-generator/...` fails here (binary name collides with the dir); use -o

/tmp/wrg -week=2026-W27 -print-data              # dump collected ReportData JSON, exit (no LLM)
/tmp/wrg -week=2026-W27 -print-prompt            # print the exact LLM user prompt, exit (no LLM)
/tmp/wrg -week=2026-W27 -dry-run                 # full generation + quality check, nothing stored
/tmp/wrg -month=2026-06 -dry-run                 # monthly
/tmp/wrg -year=2025 -dry-run                     # year-in-review
/tmp/wrg -week=2026-W27 -force -max-retries=2    # regenerate a real slug (archives old version to generation_history)
```

Flags: `-week` / `-month` / `-year` (slug; default = current ISO week), `-report-type` (`weekly|monthly|yearly` hint when no slug — same as `REPORT_TYPE` env), `-dry-run`, `-force` (archive previous version into `generation_history` JSONB before overwrite), `-max-retries` (quality-retry attempts, default 1), `-print-data`, `-print-prompt`.

**Prod** (project `rosy-clover-477102-t5`): Cloud Run **job** `weekly-report-generator` + two Cloud Scheduler jobs — Terraform module `terraform/modules/weekly-report-generator/`, instantiated in `terraform/environments/prod/main.tf`:

- `weekly-report-generator-weekly`: Fri 11:00 UTC (9 PM AEST), plain `jobs/...:run`.
- `weekly-report-generator-monthly`: 1st of month 01:00 UTC, POSTs `overrides.container_overrides` setting **`REPORT_TYPE=monthly`** (scheduler can't pass args; the binary reads the env). This override path needs `roles/run.developer` on the job for the scheduler SA (`run.invoker` alone 403s) — already in the module.
- Job env: `DATABASE_URL` / `OPENAI_API_KEY` / `OTEL_EXPORTER_OTLP_HEADERS` from Secret Manager. **`gemini_secret_exists = false` in prod main.tf** → no `GEMINI_API_KEY` in prod: single-model GPT pass, no amalgamation, no Gemini review (programmatic-only quality gate). Flip the var once the secret is provisioned.
- No yearly scheduler — yearly runs are manual (`-year=YYYY`).
- `REVALIDATION_URL` + `REVALIDATION_SECRET` (not in the TF module yet): when both set, the job POSTs `<url>?secret=...&tag=report-<slug>` after storing — the web app's `/api/revalidate` route busts the `report-<slug>` cache tag.

Side effect on publish (`quality.PublishReady && !yearly`): `insertReportBroadcastDraft` inserts a **draft** `broadcasts` row (`weekly_report`/`monthly_report`, idempotent on `(type, source_ref)`) for admin review at `/admin/broadcasts`. Non-fatal on failure; nothing is emailed automatically.

Manual prod trigger: `CLOUDSDK_CORE_ACCOUNT=ben@shorted.com.au CLOUDSDK_CORE_PROJECT=rosy-clover-477102-t5 gcloud run jobs execute weekly-report-generator --region=australia-southeast2`.

## 4. Prompt iteration protocol (the LLM instruction set)

Prompts live in `services/weekly-report-generator/prompts.go`:

- `styleCore` — shared accuracy discipline (exact figures only, no invented tickers/URLs), AU-English voice, banned AI-isms, citation rules. Do not weaken.
- `dataSignalsGuide` — how the model must use each quantitative signal (z-score sigma language only at |z|≥2, streaks = crowding building, days-to-cover >8 = squeeze risk / 0 = don't mention, new-entrant callouts, industry_analysis grounded ONLY in the INDUSTRY BREAKDOWN aggregates, history = grind-vs-spike trajectory, breadth stats).
- Three role blocks: `analyticalRole` (GPT pass 1), `columnistRole` (Gemini pass 1), `editorRole` (amalgamation pass 2). Composed with styleCore + guide + `jsonStructureBlock` at package init.
- `narrativeResultJSONSchema` — strict OpenAI structured-output schema (falls back to `json_object` on error; Gemini uses `ResponseMIMEType=application/json`).

Two-pass synthesis (`llm_generator.go`): GPT (`gpt-5.2`) and Gemini (`gemini-3.5-flash`) each draft independently; the editor persona (GPT) amalgamates; model column records `gpt-5.2+gemini-3.5-flash+gpt-5.2-amalgamated`. If `GEMINI_API_KEY` is unset (prod today), it's a single GPT pass. The user prompt is built by `buildUserPrompt` (`llm_generator.go`).

**The safe iteration loop** (never start with `-force` on a real slug):

1. Edit `prompts.go` (or `buildUserPrompt`).
2. `go build -o /tmp/wrg ./weekly-report-generator/ && /tmp/wrg -week=<slug> -print-prompt` — inspect **exactly** what the model sees. Zero API cost. Use `-print-data` when debugging whether a signal is even collected.
3. `/tmp/wrg -week=<slug> -dry-run` with keys — full generation + quality check, nothing stored. Read the logged programmatic issues and the final `quality: X.XX (publish_ready: ...)` line.
4. Only when the dry run looks right: `-force` regenerate real slugs (previous version is archived to `generation_history` first).

**Sync rule:** `dataSignalsGuide` must stay in lockstep with what `buildUserPrompt` actually emits (which in turn depends on what the collector provides). **Never instruct the model about a signal that isn't in the prompt data** — that's a hallucination invitation, and the hallucination checks (§5) will then fail the report. `prompts_test.go` pins the prompt sections; extend it when adding a signal.

## 5. Quality gates (`quality_checker.go`)

Programmatic checks (`programmaticCheck`) — each issue is a string in the feedback:

- **AI-isms**: `aiIsmPhrases` list ("delve", "landscape", "robust", …) anywhere in headline+summary+narrative.
- **Word counts**: 100–800 (yearly 200–1500); headline ≤ 80 chars; top stock code must be mentioned.
- **Percentage verification**: every `\d+.\d+%` in the text must match a value in `buildValidPercentageSet` (all short %s, WoW changes, history points, industry aggregates, market stats, price changes) within **±0.02 tolerance**. `[ref-N]` markers are stripped first.
- **Hallucinated tickers** (`checkHallucinatedTickers`): only `(CODE)` and `$CODE` contexts are checked against `validCodeSet`; allowlist for ASX/ASIC/CEO/etc. **WOW is deliberately NOT allowlisted** (real ticker; "WoW" prose is mixed-case).
- **Hallucinated URLs** (`checkHallucinatedURLs`): any http(s) URL in narrative or citations must exist in `FinancialRefs` (trailing-punct/slash tolerant).
- **Citation integrity**: every defined citation must be referenced as `[ref-N]` and vice versa.
- **FAQ count**: 3–5 (yearly up to 8).

Gemini review (`geminiReview`, `gemini-3.5-flash`, temp 0): scores 0–1; programmatic issues multiply its score by 0.8. If Gemini is unavailable, fallback scoring = `1.0 − 0.15·issues`, publish when score ≥ **0.7 AND ≤ 2 issues**. **Monthly is lenient by design** (min score 0.1, ≤ 10 issues, 0.10/issue) — monthly data is thin and monthly reports systematically score lower; don't "fix" this by tightening.

Retry behaviour (`main.go`): up to `-max-retries` `GenerateWithFeedback` rounds when not publish-ready; **best-of-N** — the highest-scoring attempt is stored, not the last. A quality-check *error* (not failure) defaults to score 0.5 / publish-ready. Not publish-ready ⇒ stored with `published_at = NULL` (invisible to `ListReports`, which filters `published_at IS NOT NULL`).

## 6. Verification checklist for changes

```bash
cd services
go build -o /tmp/wrg ./weekly-report-generator/ && go vet ./weekly-report-generator/... && go test ./weekly-report-generator/... -count=1
go build ./shorts/... && go vet ./shorts/... && go test ./shorts/...      # read path
cd ../proto && buf generate                                               # ONLY after proto changes
cd ../web && npx tsc --noEmit && npx jest reports                         # getReportsList.test.ts + page-runtime + report component tests
```

UI smoke (dev server on :3020): load `/reports` (index cards render with headlines + logos) and one weekly slug `/reports/weekly/<latest>` — check narrative sections, top-10 table (logos, days-to-cover, NEW badges), movers, industry breakdown, FAQs. The path production actually uses is server actions → Connect-RPC → shorts service; verify through the page, not just the RPC.

## 7. Token usage & cost tracking

Every LLM call emits a `cost_event` JSON log (contract: `docs/observability/cost-attribution.md`, same shape as chat-service/news-aggregator): `feature="weekly_report"`, `model`, `phase` (`draft` / `amalgamate` / `quality_review`), `status`, token counts, `estimated_cost_usd` when priced. OTel counters: `AIRequestsTotal` / `AITokensTotal` with a `token_type` attribute. A per-model run summary logs at the end (`LLM usage [slug] …`). Rates: `defaultPriceTable` in `cost_metrics.go` (July 2026 list prices — gpt-5.2 $1.75/$14 per 1M in/out, gemini-3.5-flash $1.50/$9); override without deploy via `LLM_PRICE_TABLE_JSON`. A full two-pass weekly run ≈ 155–165k tokens ≈ **US$0.30**. Keep cost_events low-cardinality — no slugs/stock codes in them (the run summary line carries the slug instead).

## 8. Landmines

- **Supabase pooler**: the generator pins `QueryExecModeSimpleProtocol` + `MaxConns=2` (`main.go`) for the transaction pooler (6543). Keep both when touching pool config; parameterized-protocol queries break on the pooler.
- **JSON contract** (§2). Also: `history` uses `omitempty` — an empty slice drops the key, which proto-unmarshals identically to absent (pinned by `TestHistoryOmittedWhenEmpty`).
- **Logo hydration is READ-time only**: never store logo URLs in snapshots — old reports pick up logo changes automatically via `hydrateWeeklyReportBranding` / `ListReports` hydration. **Industry hydration only fills empty values** — a stored industry wins over company-metadata.
- **ISO-week edge cases**: `isoWeekDateRange` (`data_collector.go`) anchors on Jan 4 (always ISO week 1). Week 1 can start in the previous calendar year and some years have a W53 — always pass explicit `-week=YYYY-Wnn` slugs when backfilling around year boundaries, and sanity-check `report_date`/`previous_date` with `-print-data`.
- **Monthly data thinness**: fewer distinct data points → lower scores; the lenient monthly threshold (§5) exists for this.
- **Revalidation tag format is `report-<slug>`** (index tag: `reports-index`, 1h TTL; per-report `unstable_cache` fallback 24h). A regenerated report may serve stale until the tag is revalidated or TTL expires.
- **Enrichment queries degrade silently**: history/volumes/industry lookups WARN-and-continue on failure — a report with all-zero z-scores/days-to-cover usually means a collection query failed or local DB lacks `stock_prices`/`company-metadata` rows, not a code bug. Check the job logs for `WARNING:`.
- **No OPENAI_API_KEY ⇒ data-only report** stored and auto-published with a templated headline — fine locally, but don't let prod run without the secret.
- **Gemini model retirement kills the second pass SILENTLY**: the Gemini draft + review are WARN-and-continue, so when Google retires the pinned model (e.g. `gemini-3-pro-preview` 404'd "no longer available" in July 2026) every report quietly falls back to single-GPT with fallback scoring and nobody notices. If `llm_model` in recent `weekly_reports` rows stops carrying the `+gemini…+…-amalgamated` suffix, check the logs for a Gemini 404 and bump the model (currently `gemini-3.5-flash`, in `llm_generator.go` + `quality_checker.go`). The Secret-Manager `GEMINI_API_KEY` is known-INVALID; the working key is in repo-root `.env`.
- **Prompt figures must be 2dp**: the checker validates narrative percentages against exact source values (±0.02). Any `%.1f` percentage rendered into the prompt (price changes, signals) guarantees "unverified percentage" flags because the model copies what it sees — keep every percentage in `buildUserPrompt`/trend signals at `%.2f`.
- **Enrichment JSONB contains literal `"Infinity"` strings** (e.g. `pe_ratio` for zero-EPS companies): `parseKeyMetrics` rejects non-finite floats (`finite()` guard) — without it, `json.Marshal(ReportData)` fails and prompts get `+Inf` valuations (pinned by `TestParseKeyMetricsRejectsNonFinite`).
- **Build gotcha**: `go build ./weekly-report-generator/...` from `services/` fails (output binary collides with the directory name); always `go build -o /tmp/wrg ./weekly-report-generator/`.
- **Edge cache**: `ListReports` isn't in the edge worker's public-read cache regexes (`services/edge-worker/worker.js`) — it works (default TTL) but doesn't get the 5-min KV cache; add `|ListReports` there if index latency matters.
