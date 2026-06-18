# Stock Intelligence Panel — Semantic + Light-Graph Knowledge Layer

**Date:** 2026-06-18
**Status:** Design — pending review
**Branch:** `feat/stock-intelligence-panel`
**Scope:** Slice 1 of the "per-stock knowledge graph" vision

---

## 1. Goal

Evolve Shorted's financial-report / announcement / news aggregation into a **per-stock knowledge graph** that improves the platform's selling proposition. Slice 1 delivers a visible, product-facing win: an **"Apple-style" Stock Intelligence Panel** on `/shorts/[code]` that fuses short-interest signals with:

- semantically deduped, cross-outlet **related news discovery**,
- a merged **event timeline** (announcements + director trades + short spikes + price-sensitive news),
- a **people & peers** mini-graph (real linked entities, not `WHERE industry=` queries),
- a **compressed financial-report digest** (fetch-on-demand, distilled, cited).

The system stores **pointers** to key details and **fetches + compresses content on demand**, optimised for cost (≈$5 one-time + ~$10/yr ongoing AI spend) while maximising insight value.

### Decisions locked (from brainstorming)

| Decision | Choice |
|---|---|
| North star | Per-stock UX panel (Apple-style) — product-facing |
| Cost / coverage | **Hybrid**: eager ingest for top-N most-shorted/most-viewed, lazy on-demand for the long tail |
| Deliverable scope | One focused, shippable slice |
| Graph depth | **Light graph**: persons (key_people + director_trades) + peer edges (industry + narrative-similarity) + cheap headline-NER mentions; defer body-NER |
| Embeddings | **Gemini `text-embedding-004`** (768-dim) — reuses `genai` Go client + `GEMINI_API_KEY` in `news-aggregator` |
| Storage substrate | **Postgres + pgvector** in the existing Supabase DB — no separate graph DB |

---

## 2. Current state (the gap this closes)

Today Shorted's per-stock knowledge is a **star schema, not a graph**: flat tables hang off `company-metadata.stock_code` (`shorts`, `stock_prices`, `news_articles`, `director_trades`, `dividend_history`, `asx_announcements`) plus enriched JSONB columns and narrative outputs (`weekly_reports`, `editorial_takes`). Three structural gaps:

1. **No semantic layer.** Zero embeddings. Similarity is `tsvector` + 3-gram headline shingles (`clustering.go`). Cross-outlet event dedup and related-news discovery are impossible.
2. **No entity/edge layer.** `key_people` is opaque JSONB; `director_trades.director_name` is a string. Peers = a runtime `WHERE industry=` query. No stored, queryable relationships.
3. **Financial reports are the weakest link — and a schema landmine.** `services/report-extractor/extract.py` distils PDFs (via langextract + `gemini-2.5-flash`) into `financial_report_extractions`, but **that table has no migration** — it's created at runtime via `ensure_table()` (undocumented prod schema). It keeps only `raw_text_length` (discards raw text), has no confidence score, no compressed digest.

What already works in our favour: pointer-not-blob is the house pattern; `extract.py` is a working distiller; the Flash-batch sentiment path (`sentiment_analyzer.go`) is the proven cheap-compression primitive; the newsroom `CitationLedger` (`scripts/take-writer/src/ledger.ts`) is a ready-made provenance format; MVs (`mv_screener_data`) are ready-made graph read-models.

---

## 3. Architecture overview

A **thin semantic + light-graph layer on top of the existing Postgres**. Three concerns, all in the same Supabase DB, fed by a cost-gated distillation pipeline that reuses existing primitives.

```
                        ┌─────────────────────────────────────────────┐
                        │        Stock Intelligence Panel (UI)         │
                        │  /shorts/[code]: News · Timeline · People ·  │
                        │  Peers · Compressed Financials               │
                        └───────────────┬─────────────────────────────┘
                                        │ Connect-RPC (new RPCs)
                        ┌───────────────▼─────────────────────────────┐
                        │     Retrieval layer (Go store + service)     │
                        │  GetRelatedNews · GetStockGraph ·            │
                        │  GetEventTimeline · GetReportDigest          │
                        │  + 2 new chat-service tools                  │
                        └───────────────┬─────────────────────────────┘
        ┌───────────────────────────────┼───────────────────────────────┐
        ▼                               ▼                               ▼
┌───────────────┐            ┌────────────────────┐          ┌────────────────────┐
│  embeddings    │            │   entities /        │          │   content_store    │
│  (pgvector 768)│◄───────────│   entity_edges      │          │  hash → {url, gcs, │
│  semantic ANN  │            │   (light graph)     │          │  distilled<2KB}    │
└───────▲────────┘            └─────────▲───────────┘          └─────────▲──────────┘
        │                               │                                │
        │           ┌───────────────────┴────────────────────────────────┘
        │           │   Ingestion (hybrid, min-instance-0 Cloud Run Jobs)
        │           │   • eager: top-N fetch+distil+embed (batched Flash)
        │           │   • lazy: signal-gated (short spike / price-sensitive
        │           │     announcement / newsroom assignment / first view)
        │           │   • dedup by content_hash → never re-pay
        └───────────┴────────────────────────────────────────────────────
              reuses: extract.py distiller · sentiment_analyzer Flash batch ·
              stealthhttp fetch · editor.ts novelty gate · CitationLedger format
```

---

## 4. Data model — 5 migrations (`000044`–`000048`)

All additive. SQL below is the design intent; exact DDL finalized in the implementation plan.

### `000044_add_content_store`
The pointer-not-blob heart. One row per fetched document, **content-addressed** so a syndicated story or sector-wide report is distilled once and reused across every referencing stock.

```sql
CREATE TABLE content_store (
  content_hash  TEXT PRIMARY KEY,            -- SHA256 of source bytes
  kind          TEXT NOT NULL,               -- 'news_body' | 'report_pdf' | 'announcement'
  source_url    TEXT NOT NULL,
  gcs_url       TEXT,                         -- raw bytes, cold (shorted-financial-reports / news bucket)
  distilled     JSONB,                        -- <2KB: {summary, key_facts[], entities[]}
  model         TEXT,                          -- distillation model id
  byte_size     INT,
  fetched_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_content_store_kind ON content_store(kind);
-- Link from existing rows (lazy-populated):
ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS content_hash TEXT;  -- → content_store
```

### `000045_add_embeddings`
The missing similarity primitive. Embed-once, query-many.

```sql
CREATE EXTENSION IF NOT EXISTS vector;        -- Supabase-native
CREATE TABLE embeddings (
  id           BIGSERIAL PRIMARY KEY,
  object_type  TEXT NOT NULL,                  -- 'news_article' | 'company_summary' | 'report_chunk'
  object_id    TEXT NOT NULL,                  -- news_articles.id | stock_code | content_hash:chunk
  chunk_idx    INT NOT NULL DEFAULT 0,
  embedding    vector(768) NOT NULL,           -- gemini text-embedding-004
  model        TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (object_type, object_id, chunk_idx)
);
CREATE INDEX idx_embeddings_hnsw ON embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_embeddings_object ON embeddings(object_type, object_id);
```

> **Risk note:** confirm pgvector is enabled on the Supabase project and that the **transaction pooler (6543, SimpleProtocol)** path used by market-data handles `vector` params. HNSW build over the backfill set must be benchmarked.

### `000046_formalize_financial_report_extractions`
**Reconcile the runtime `ensure_table()` schema into a managed migration** (mirror `extract.py:427` exactly), then add the compression + provenance fields. Must be idempotent because the table already exists in prod.

```sql
-- Mirror the live runtime schema EXACTLY (extract.py ensure_table):
CREATE TABLE IF NOT EXISTS financial_report_extractions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_code       VARCHAR(50) NOT NULL,
  report_url       TEXT NOT NULL UNIQUE,
  report_type      VARCHAR(50),
  report_title     TEXT,
  report_date      DATE,
  metrics          JSONB NOT NULL DEFAULT '{}',
  raw_text_length  INTEGER,
  extracted_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fre_stock_code  ON financial_report_extractions(stock_code);
CREATE INDEX IF NOT EXISTS idx_fre_report_date ON financial_report_extractions(report_date DESC);
CREATE INDEX IF NOT EXISTS idx_fre_report_type ON financial_report_extractions(report_type);

-- NEW: the "compressed financial report" the user asked for + provenance:
ALTER TABLE financial_report_extractions
  ADD COLUMN IF NOT EXISTS digest         TEXT,           -- Flash-distilled narrative summary
  ADD COLUMN IF NOT EXISTS confidence     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS content_hash   TEXT,           -- → content_store (raw PDF cold-store)
  ADD COLUMN IF NOT EXISTS digest_model   TEXT;
```

> The implementation plan must read `extract.py`'s current `ensure_table()` verbatim before finalizing, and `extract.py` should be updated to drop `ensure_table()` in favour of the migration (or keep it as a no-op guard).

### `000047_add_entities`
Light entity layer — makes it a graph, not just search.

```sql
CREATE TABLE entities (
  id               BIGSERIAL PRIMARY KEY,
  type             TEXT NOT NULL,             -- 'company' | 'person' | 'fund' | 'regulator'
  canonical_name   TEXT NOT NULL,
  normalized_name  TEXT NOT NULL,             -- lowercased, suffix-stripped (reuse companyNameToLinkedInSlug logic)
  stock_code       TEXT,                       -- type='company' → 1:1 with company-metadata
  aliases          TEXT[] NOT NULL DEFAULT '{}',
  attrs            JSONB NOT NULL DEFAULT '{}',
  first_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (type, normalized_name)
);
CREATE INDEX idx_entities_stock_code ON entities(stock_code);
```

### `000048_add_entity_edges`
Stored, weighted, evidence-backed relationships. `evidence_refs` uses the `CitationLedger` shape.

```sql
CREATE TABLE entity_edges (
  id            BIGSERIAL PRIMARY KEY,
  src_id        BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  dst_id        BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  edge_type     TEXT NOT NULL,                -- 'peer_of' | 'directs' | 'mentions'
  weight        DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  evidence_refs JSONB NOT NULL DEFAULT '[]',  -- [{refId,url,source,headline,date,type}]
  source        TEXT,                          -- 'industry' | 'narrative_sim' | 'director_trades' | 'headline_ner'
  valid_from    TIMESTAMPTZ,
  valid_to      TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (src_id, dst_id, edge_type)
);
CREATE INDEX idx_entity_edges_src ON entity_edges(src_id, edge_type);
CREATE INDEX idx_entity_edges_dst ON entity_edges(dst_id, edge_type);
```

---

## 5. Ingestion pipeline (hybrid, cheap-by-construction)

A scheduled **Cloud Run Job (min-instance 0)** plus lazy triggers. Reuses existing infra throughout.

**Eager tier** — for top-N most-shorted + most-viewed stocks:
1. Discover candidate docs: news bodies (from `news_articles.url`), latest financial-report PDFs (from `company-metadata.financial_reports` / `asx_announcements.pdf_url`).
2. Fetch via `services/pkg/stealthhttp` (TLS-fingerprint, WAF-resistant); store raw bytes in GCS cold-store, compute SHA256 → `content_hash`.
3. **Distil with batched Flash** (`sentiment_analyzer.go` pattern — many docs per LLM call): news body → `<2KB` `{summary, key_facts, entities}`; report PDF → `digest` + `metrics` + `confidence` (reuse/extend `extract.py`).
4. **Embed once** (Gemini `text-embedding-004`) → `embeddings`.
5. Cache by `content_hash` — re-runs and cross-stock references never re-pay.

**Lazy tier** — long tail ingested on first signal: short-position spike, price-sensitive announcement, newsroom assignment, or first page-view. Gated by the existing `editor.ts` **novelty gate** so unchanged content is skipped.

**News semantic dedup** — *augment, don't replace* `clustering.go`: keep the 3-gram first stage, then add an **embedding second stage** that merges cross-outlet coverage with divergent headlines (the case 3-grams miss). Low-risk; preserves the working path.

**Light-graph backfill** (one-off + incremental):
- **Persons** from `key_people` JSONB + `director_trades.director_name`, deduped on `normalized_name`; emit `person —directs→ company` edges (`source='director_trades'`).
- **Peers**: `peer_of` edges from industry grouping (`source='industry'`) **and** narrative similarity (company-summary embeddings ANN, `source='narrative_sim'`).
- **Mentions**: a cheap **batched headline-NER** pass populates the already-empty `news_articles.tags` JSONB with mentioned tickers/people and emits `company —mentions→ company` edges (`source='headline_ner'`). No body fetch required.

---

## 6. Retrieval & API

New RPCs on `ShortedStocksService` (proto-first, 4-layer store pattern: `Store` → `ShortsStore` → `StoreAdapter` → mock):

| RPC | Returns |
|---|---|
| `GetRelatedNews(stock_code, article_id?, limit)` | Semantically related + cross-outlet-deduped news (pgvector ANN over `embeddings` + cluster merge) |
| `GetStockGraph(stock_code)` | Entity neighbours: key people (+ their other boards), peers (industry + narrative), with edges + evidence |
| `GetEventTimeline(stock_code, window)` | Merged stream: announcements + director trades + short-position spikes + price-sensitive news, newest-first |
| `GetReportDigest(stock_code)` | Latest compressed financial-report `digest` + key `metrics` + `confidence`, citing the source PDF |

Two new **chat-service tools** beside the existing 8 (`tools.go` + `tool_executor.go`):
- `get_related_news(stock_code)` → related/deduped coverage
- `get_entity_neighbors(stock_code)` → people + peers graph

This exposes the graph through the already-built LLM tool-calling loop with zero new frontend surface.

---

## 7. Frontend — the Stock Intelligence Panel

Enhances the existing `/shorts/[code]` tabs (`stock-tabs.tsx`) rather than replacing them. Bespoke editorial surfaces are fine (per global UI guidance); shadcn primitives for controls.

- **News tab** (`stock-news-feed.tsx`) → Apple-style discovery: event-clustered, cross-outlet-deduped feed with source attribution + sentiment, and a "more on this story" semantically-related rail.
- **Overview** (`company-overview.tsx`) → **Event timeline**: the single merged stream that currently requires bespoke joins; **People & peers mini-graph**: directors as linked entities (showing their other ASX boards) + peers by industry *and* narrative similarity.
- **Financials tab** (`companyFinancials.tsx`) → **Compressed report digest**: the `digest` field as a readable summary with key metrics + a "view source PDF" citation. The literal "compressed financial reports" ask.

Server actions follow the established pattern (`app/actions/` server-side with `cache()` + `withRetryAndNotFound()`; client components import from `app/actions/client/`; SSR-safe, no `@connectrpc/connect` in shared modules).

---

## 8. Cost model

| Phase | Cost |
|---|---|
| One-time backfill (embed live news + summaries, distil top-N reports, headline-NER seed) | **~$3–6** |
| Ongoing AI (hybrid: embeddings + Flash distillation + headline-NER) | **~$6–12 / year** |
| pgvector storage | ~150–300 MB on Supabase (within limits) |
| GCS cold-store (raw PDFs / bodies) | pennies / GB / month |

Embedding provider delta is **<$1/yr** (Gemini ~$0.15/1M vs OpenAI small ~$0.02/1M). The dominant platform AI cost remains newsroom **image generation** ($0.075/image) — untouched by this slice. **Guardrail:** all new ingestion/embedding compute runs as min-instance-0 Cloud Run Jobs (project cost rule).

---

## 9. Reuse vs. build-new

**Reuse:** `extract.py` distiller (extend with `digest`/`confidence`); `sentiment_analyzer.go` batched-Flash pattern (distillation + NER); `stealthhttp` (WAF-resistant fetch); `editor.ts` novelty gate (lazy trigger); `CitationLedger` shape (`evidence_refs`); MVs (`mv_screener_data`) as read-model joins; `genai` Go client + `GEMINI_API_KEY` (embeddings); GCS `shorted-financial-reports` bucket + SHA256 dedup (supabase migration 004 design).

**Build new:** 5 migrations; embedding-generation step in `news-aggregator` + backfill job; content_store + distillation ingestion job; light entity/edge backfill; 4 retrieval RPCs + store methods; 2 chat tools; frontend panel enhancements.

---

## 10. Out of scope (YAGNI for slice 1)

Deferred to the roadmap — schema leaves room for all:
- Full NER over fetched article **bodies** for rich `mentions` edges (slice 1 uses headline-NER only).
- Supply-chain / ownership / fund-overlap edges.
- Metric **history** time-series (quarterly P/E, market-cap trajectory).
- Persisting the full newsroom **Dossier** (threads/timeline/keyNumbers) as first-class edges.
- A **sellable external** knowledge-graph / news API product.
- ESG, analyst consensus, cross-exchange consolidation.

---

## 11. Build sequence

1. **Migrations** `000044`–`000048` (+ reconcile `financial_report_extractions` with live `ensure_table()`; confirm pgvector on Supabase). Update `extract.py` to stop owning the schema.
2. **Embeddings**: generation step in `news-aggregator` + one-off backfill job (live news + company summaries); semantic dedup second stage in/after `clustering.go`.
3. **Content-store + distillation**: ingestion job (fetch → GCS → Flash distil → embed → cache by hash); extend `extract.py` to write `digest`/`confidence`/`content_hash`; wire hybrid eager/lazy gating.
4. **Light graph backfill**: persons (key_people + director_trades), `directs` edges, `peer_of` (industry + narrative), headline-NER `mentions`.
5. **Retrieval**: 4 RPCs + store methods (all 4 layers + mock) + service handlers.
6. **Chat tools**: `get_related_news`, `get_entity_neighbors`.
7. **Frontend**: News tab discovery, event timeline, people/peers mini-graph, compressed report digest.

Each phase is independently shippable and verifiable in the running app (the production path, per project testing rules).

---

## 12. Risks & open questions

- **`financial_report_extractions` reconciliation** — migration must mirror the live runtime schema exactly or risk prod drift; apply manually via psql with `statement_timeout=0` (per prod-migration convention).
- **pgvector on Supabase** — confirm extension + transaction-pooler (`SimpleProtocol`) compatibility; benchmark HNSW build on backfill.
- **News body fetching** — publisher paywalls/WAFs; `stealthhttp` mitigates but not universally. Lazy tier limits exposure; we degrade to headline+summary when body fetch fails.
- **Entity disambiguation** — "John Smith" across companies; slice 1 dedups on `normalized_name` only (accept some false merges/splits; revisit with richer keys later).
- **Backfill embedding throughput** — batch + rate-limit against Gemini quotas; run as a bounded job.

---

## 13. Success criteria

- `/shorts/[code]` **News tab** shows cross-outlet, semantically-deduped related coverage — measurably better dedup recall than the 3-gram baseline.
- **Compressed financial-report digest** visible + cited on the Financials tab for top-N stocks.
- **People & peers** graph renders with directors (linked to their other boards) + narrative-similar peers.
- **Event timeline** merges announcements + trades + short spikes + price-sensitive news per stock.
- Chat can answer "what's related to X?" / "who's connected to X?" via the 2 new tools.
- Ongoing AI cost stays ≈$10/yr; **no** min-instance>0 services introduced.
