# weekly-report-generator

Cloud Run job that generates the weekly / monthly / yearly ASX short-selling reports published at `shorted.com.au/reports`. Collects ASIC short data + prices + company metadata from Postgres, builds a quantitative snapshot, synthesises a narrative with a two-pass multi-model LLM pipeline, runs a quality gate, and upserts one row into the `weekly_reports` table (weekly `2026-W23`, monthly `2026-05`, and yearly `2025` slugs all share the table — slug shape disambiguates).

Full operating manual (prompt-iteration protocol, landmines, prod ops): `.claude/skills/weekly-reports/SKILL.md`.

## Pipeline

1. **Collect** (`data_collector.go` / `monthly_collector.go` / `yearly_collector.go`): top-shorted stocks for the report date + previous period, 13-week short-% history, 20-day avg volumes (days-to-cover), industry map, company context, announcements, financial reports, price context.
2. **Snapshot** (`snapshot.go`, pure/tested): movers ranked by a composite **significance** score (change × relative-move × z-score), z-scores vs each stock's own weekly-delta history, same-direction streaks, new-entrant detection, market breadth stats, per-industry breakdown.
3. **Trend insights** (`trend_analyzer.go`): pattern classification per mover, fed into the prompt.
4. **Synthesis** (`llm_generator.go` + `prompts.go`): pass 1 — GPT (`gpt-5.2`, analytical persona) and Gemini (`gemini-3.5-flash`, columnist persona) draft independently; pass 2 — GPT editor persona amalgamates. Structured JSON output (OpenAI `json_schema` strict, fallback `json_object`; Gemini JSON MIME type). Without `GEMINI_API_KEY` it's a single GPT pass; without `OPENAI_API_KEY` a data-only report (no narrative) is stored.
5. **Quality gate** (`quality_checker.go`): programmatic checks (AI-isms, word/FAQ counts, percentage verification ±0.02, hallucinated-ticker `(CODE)`/`$CODE` check, hallucinated-URL check, citation integrity) + Gemini review. Best-of-N retry with feedback (`-max-retries`). Monthly threshold is deliberately lenient (thin data). Failing reports are stored unpublished (`published_at IS NULL`).
6. **Store + side effects** (`main.go`): upsert on `week_slug` (with `-force`, the previous version is archived to `generation_history`); on publish, insert a draft `broadcasts` row (`broadcast_draft.go`, reviewed at `/admin/broadcasts`) and fire Next.js tag revalidation (`report-<slug>`).

The JSONB columns are read by the shorts API via `json.Unmarshal` **directly into generated proto structs** — the snake_case json tags on `TopStock`/`Mover`/`MarketStats`/`IndustryStat` are a hard contract, enforced by `json_contract_test.go`.

## Flags

| Flag | Meaning |
|---|---|
| `-week 2026-W27` | Weekly report for an ISO-week slug (default: current week) |
| `-month 2026-06` | Monthly report |
| `-year 2025` | Year-in-review report |
| `-report-type weekly\|monthly\|yearly` | Type hint when no slug given (Cloud Scheduler; `REPORT_TYPE` env equivalent) |
| `-dry-run` | Full generation + quality check, nothing stored |
| `-force` | Regenerate an existing slug (archives old version to `generation_history`) |
| `-max-retries N` | Quality-retry attempts, best-of-N kept (default 1) |
| `-print-data` | Dump collected `ReportData` JSON and exit (no LLM call) |
| `-print-prompt` | Print the exact LLM user prompt and exit (no LLM call) |

## Environment

| Var | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres (Supabase txn pooler safe: SimpleProtocol, MaxConns=2) |
| `OPENAI_API_KEY` | for narrative | GPT drafts + amalgamation; absent → data-only report |
| `GEMINI_API_KEY` | optional | Second draft + Gemini quality review; absent → single-pass GPT + programmatic-only gate |
| `REPORT_TYPE` | optional | `monthly`/`yearly` auto-slug (used by the monthly scheduler's container override) |
| `REVALIDATION_URL` + `REVALIDATION_SECRET` | optional | POST `?secret=&tag=report-<slug>` to the web app after store |
| `OTEL_EXPORTER_OTLP_*` | optional | Traces/metrics; no-op when unset |
| `LLM_PRICE_TABLE_JSON` | optional | Override per-1M-token USD rates for cost estimates, e.g. `{"gpt-5.2":{"input_per_1m":1.75,"output_per_1m":14.0}}`. Defaults for gpt-5.2 + gemini-3.5-flash are baked in (July 2026 list prices, `cost_metrics.go`) |

## Token usage & cost tracking

Every LLM call emits a `cost_event` JSON log line (contract:
`docs/observability/cost-attribution.md`; same shape as chat-service and
news-aggregator) with `feature="weekly_report"`, `model`, `phase`
(`draft`/`amalgamate`/`quality_review`), `status`, token counts, and
`estimated_cost_usd` when the model is priced. The same counts feed the OTel
counters `shorted.ai.requests`/`shorted.ai.tokens`. At the end of each run a
per-model summary is logged, e.g.:

```
LLM usage [2026-W28] gpt-5.2: 2 requests, 61848 prompt + 4983 candidate = 66831 tokens, est. $0.178
LLM usage [2026-W28] gemini-3.5-flash: 2 requests, 76390 prompt + 1605 candidate = 87901 tokens, est. $0.129
LLM usage [2026-W28] TOTAL: 154732 tokens, est. $0.307
```

A full two-pass weekly run costs roughly **US$0.30** at July 2026 list prices.
Rates live in `defaultPriceTable` (`cost_metrics.go`) — update them when
provider pricing changes, or override without a deploy via
`LLM_PRICE_TABLE_JSON`.

## Run locally

```bash
cd services
export DATABASE_URL=postgresql://admin:password@localhost:5438/shorts

# NOTE: use -o; bare `go build ./weekly-report-generator/...` collides with the dir name
go build -o /tmp/wrg ./weekly-report-generator/

/tmp/wrg -week=2026-W27 -print-data      # inspect collected data (no API keys needed)
/tmp/wrg -week=2026-W27 -print-prompt    # inspect the exact LLM prompt
/tmp/wrg -week=2026-W27 -dry-run         # full run, nothing stored (needs OPENAI_API_KEY)
```

## Test

```bash
cd services && go test ./weekly-report-generator/... -count=1
```

Pure-logic tests only (no DB/network): `snapshot_test.go`, `quality_checker_test.go`, `prompts_test.go`, `json_contract_test.go`.

## Deploy

Terraform module `terraform/modules/weekly-report-generator/` (prod env): Cloud Run job + weekly scheduler (Fri 11:00 UTC) + monthly scheduler (1st, 01:00 UTC, `REPORT_TYPE=monthly` container override — needs `roles/run.developer`, already bound). Yearly runs are manual. Prod currently has `gemini_secret_exists = false` (GPT-only).
