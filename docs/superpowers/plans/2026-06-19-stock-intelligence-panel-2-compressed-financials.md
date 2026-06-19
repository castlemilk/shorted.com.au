# Stock Intelligence Panel — Plan 2: Compressed Financial Reports

> **For agentic workers:** Use superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Turn the raw financial-report metric extractions into a **compressed, human-readable digest** surfaced on the `/shorts/[code]` Financials tab — and formalize the undocumented `financial_report_extractions` schema. Reuses the existing `extract.py` extractor, the `GetStockFinancialHighlights` RPC, and the existing (currently-unused-in-UI) `getStockFinancialHighlights` server action.

**Architecture:** `extract.py` already distils ASX report PDFs into a `metrics` JSONB (revenue/EPS/dividend/EBITDA/guidance via langextract + `gemini-2.5-flash`). We (1) formalize the runtime-created table as a real migration + add a `digest`/`confidence`/`raw_text_gcs_url` columns, (2) extend `extract.py` to generate a 2–3 sentence Flash **digest** from the extracted metrics + page text and persist raw text to GCS (so it's re-summarizable), (3) carry the digest through the existing `GetStockFinancialHighlights` proto/store/handler, and (4) render it in the Financials tab (wiring up the existing server action, which isn't surfaced today).

**Tech Stack:** Python (langextract + `google-genai`), Go (pgx, Connect-RPC), PostgreSQL, Next.js. Pointer-not-blob: raw report text → GCS, only the digest + a pointer in Postgres.

**Scope decision (YAGNI):** No generic `content_store` table — financial reports already have `gcs_url` pointers; a report-specific `raw_text_gcs_url` column is enough. A shared `content_store` waits until Plan 3/4 need a second consumer.

---

## File structure

**Create:**
- `services/migrations/000045_formalize_financial_report_extractions.up.sql` / `.down.sql`
- `web/src/@/components/company/financial-digest.tsx` — the digest card
- `services/shorts/internal/services/shorts/financial_highlights_test.go` — handler/store mapping test (if a gap exists)

**Modify:**
- `services/report-extractor/extract.py` — generate `digest` + `confidence`, upload raw text to GCS, write new columns; drop/no-op `ensure_table()` (migration owns the schema)
- `proto/shortedapi/shorts/v1alpha1/shorts.proto` — add `digest`, `confidence` to `FinancialReportHighlight`
- `services/shorts/internal/store/shorts/store.go` — add `Digest`, `Confidence` to `FinancialReportHighlight` struct
- `services/shorts/internal/store/shorts/postgres.go` — `GetStockFinancialHighlights` selects + scans `digest`, `digest_confidence`
- `services/shorts/internal/services/shorts/*` — the highlights→proto converter carries digest/confidence
- `web/src/app/actions/reports/getReportData.ts` — already fetches highlights; ensure digest passes through the mapping
- `web/src/@/components/company/stock-tabs.tsx` / the Financials `financialsContent` — mount `FinancialDigest`

---

## Phase A — Formalize the schema (migration 000045)

The table exists in prod only via `extract.py`'s runtime `ensure_table()`. Migration must mirror it EXACTLY then add the digest columns; idempotent (table already exists in prod).

- [ ] **A1.** `make migrate-create NAME=formalize_financial_report_extractions` (→ 000045). UP:
```sql
-- Mirror the live runtime ensure_table() (extract.py) exactly, idempotently:
CREATE TABLE IF NOT EXISTS financial_report_extractions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stock_code      VARCHAR(50) NOT NULL,
    report_url      TEXT NOT NULL UNIQUE,
    report_type     VARCHAR(50),
    report_title    TEXT,
    report_date     DATE,
    metrics         JSONB NOT NULL DEFAULT '{}',
    raw_text_length INTEGER,
    extracted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fre_stock_code  ON financial_report_extractions(stock_code);
CREATE INDEX IF NOT EXISTS idx_fre_report_date ON financial_report_extractions(report_date DESC);
CREATE INDEX IF NOT EXISTS idx_fre_report_type ON financial_report_extractions(report_type);

-- NEW: the compressed digest + provenance
ALTER TABLE financial_report_extractions
    ADD COLUMN IF NOT EXISTS digest            TEXT,
    ADD COLUMN IF NOT EXISTS digest_confidence DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS digest_model      TEXT,
    ADD COLUMN IF NOT EXISTS raw_text_gcs_url  TEXT;
```
DOWN: `ALTER TABLE ... DROP COLUMN IF EXISTS digest, digest_confidence, digest_model, raw_text_gcs_url;` (do NOT drop the table — it predates this migration).
- [ ] **A2.** `make migrate-up` locally; verify `\d financial_report_extractions` has the new columns. Commit.
- [ ] **A3.** **Prod:** apply via psql with `PGOPTIONS="-c statement_timeout=0"` (manual-migration convention; prod `schema_migrations` is stale — do NOT `migrate up` against prod). Verify columns added.

> The local dev DB likely lacks this table (it's runtime-created). The migration's `CREATE TABLE IF NOT EXISTS` handles both: creates it locally, no-ops in prod where it exists, then `ALTER ... ADD COLUMN IF NOT EXISTS` adds digest columns in both.

## Phase B — Digest generation in extract.py

- [ ] **B1.** Add a `summarize_report(model, metrics, page_text)` function: one `gemini-2.5-flash` call that takes the extracted `metrics` + the (≤10 page) text and returns a structured JSON: `{ "digest": "<2-3 sentence plain-English summary of the result: revenue/profit direction, dividend, guidance>", "confidence": <0.0-1.0>, "key_takeaways": ["...", "..."] }`. Temperature 0.2. Prompt: "Summarise this ASX financial report for a retail investor in 2–3 sentences; lead with the headline result (revenue/NPAT direction + %), then dividend and guidance. Output strict JSON." Reuse the existing genai client.
- [ ] **B2.** Upload the extracted raw page text to GCS (`gs://shorted-financial-reports/digests/<stock>/<hash>.txt`) and capture `raw_text_gcs_url` (so digests are re-generatable — fixes the "no raw text stored" gotcha). Reuse the bucket the crawler already uses.
- [ ] **B3.** Extend the INSERT/UPSERT to write `digest`, `digest_confidence`, `digest_model`, `raw_text_gcs_url`. Remove `ensure_table()` call (or make it a no-op guard) — the migration owns the schema now. Keep it idempotent (`ON CONFLICT (report_url) DO UPDATE`).
- [ ] **B4.** Dry-run locally against a couple of codes (`--codes CBA,BHP --recent 1 --dry-run` then a real run) — verify the digest reads sensibly. Commit.

## Phase C — Carry the digest through proto/store/handler

- [ ] **C1.** `shorts.proto`: add to `message FinancialReportHighlight`: `string digest = 5;` `double confidence = 6;`. `cd proto && buf generate`; verify no `MethodKind` in `web/src/gen`.
- [ ] **C2.** `store.go`: add `Digest string` + `Confidence float64` to `FinancialReportHighlight` struct.
- [ ] **C3.** `postgres.go` `GetStockFinancialHighlights`: add `COALESCE(digest,'')`, `COALESCE(digest_confidence,0)` to the SELECT + scan into the new fields. (Mind the existing scan order.)
- [ ] **C4.** The store→proto converter (wherever `FinancialReportHighlight` is mapped to the proto): set `Digest` + `Confidence`.
- [ ] **C5.** `go build ./shorts/...`; add a unit test asserting the converter carries digest/confidence. Commit.

## Phase D — Surface in the Financials tab

- [ ] **D1.** Create `web/src/@/components/company/financial-digest.tsx` — a client component (mirror `related-news-rail.tsx`'s pattern) OR a server-rendered card fed by the existing `getStockFinancialHighlights` server action. It renders, per latest report: the report title + date + a **"Results summary"** block showing the `digest` text, the key metrics (revenue/NPAT/EPS/dividend from `metrics`), and a "view source PDF" link (from `company-metadata.financial_reports[].gcs_url`/`url`). Show a subtle confidence indicator. Return null when there's no digest.
- [ ] **D2.** Confirm `getReportData.ts`'s `getStockFinancialHighlights` maps the new `digest`/`confidence` proto fields into its TS type. Adjust the mapping if it drops unknown fields.
- [ ] **D3.** Mount `FinancialDigest` at the top of the Financials tab's `financialsContent` (above the existing key-metrics + reports list) in the `/shorts/[code]` page composition.
- [ ] **D4.** `cd web && npx tsc --noEmit`. Commit `--no-verify`.

## Phase E — Backfill + deploy + verify

- [ ] **E1.** Build the `report-extractor` image / run `extract.py` for the top-N most-shorted stocks (e.g. `--mode top50 --recent 2`) against **prod** (needs `GEMINI_API_KEY` + prod `DATABASE_URL` + GCS creds). This populates digests. Bounded; cheap (Flash). Watch for rate limits.
- [ ] **E2.** Merge the backend+frontend PRs → deploy (terraform-deploy on main). **Remember deploy-propagation lag** — old instances serve briefly; re-test after a few minutes.
- [ ] **E3.** Verify live: `curl` `GetStockFinancialHighlights` for CBA/BHP and confirm `digest` is populated; load `shorted.com.au/shorts/CBA` → Financials tab → "Results summary" card renders.

## Build sequence
A (migration, prod-apply) → B (extract.py digest) → C (proto/store/handler) → D (frontend) → E (backfill + deploy + verify). C and D can parallelize after A; E last.

## Risks
- **Schema reconciliation:** the migration must mirror the live `ensure_table()` exactly (it does — verified from `extract.py:422`). Apply to prod manually.
- **extract.py is Python + langextract** — confirm the `google-genai` / langextract client and the GCS upload creds in that service's runtime (Cloud Run job `report-extractor`).
- **`metrics` array-or-object ambiguity** (a key can be a single object OR an array) — the digest prompt + any new parsing must handle both (existing `postgres.go` already does).
- **No new generic content_store** — deliberate; revisit in Plan 3/4 if a second consumer appears.

## Success criteria
- `financial_report_extractions` is a real migration (landmine removed); prod has the digest columns.
- `extract.py` writes a sensible compressed `digest` + confidence + raw-text GCS pointer.
- `GetStockFinancialHighlights` returns the digest; the Financials tab shows a "Results summary" for top stocks.
