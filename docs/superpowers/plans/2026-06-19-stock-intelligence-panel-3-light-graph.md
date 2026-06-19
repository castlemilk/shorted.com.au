# Stock Intelligence Panel — Plan 3: Light Knowledge Graph

> Use superpowers:subagent-driven-development.

**Goal:** A light entity/edge graph that adds genuinely new per-stock value over the existing (already-rendered) key-people / industry-peers tables: **(a) cross-company person linkage** — a director/exec linked to their *other* ASX boards — and **(b) narrative-similar companies** — peers by meaning, not just industry. Surfaced as a "Connections" section on the stock page.

**Architecture:** Two new tables (`entities`, `entity_edges`) in Postgres. Backfill **person** entities from `company-metadata.key_people` + `director_trades.director_name` (deduped by normalized name) with `person→company` edges (so one person ties to many stocks). Backfill **company_summary embeddings** (reuse the Plan-1 `embeddings` table + the news-aggregator embedder, embedding `enhanced_summary`+`company_history`) and compute top-K `similar_to` edges via HNSW. Serve via a new `GetStockGraph` RPC; render a "Connections" card.

**Reuses:** `embeddings` table + HNSW (Plan 1 — **use the literal-vector query**, never CROSS JOIN); the news-aggregator embedder (`gemini-embedding-001`, MRL-768); the 4-layer store pattern.

**Scope (YAGNI):** NO news-mention/NER edges (no NER exists; `news_articles.tags` is empty — deferred per spec). NO interactive D3 graph viz — a clean table/card "Connections" view (tables already carry this data density). Industry peers stay in the existing Peers tab; the graph adds the *narrative* peers + cross-company people.

---

## Phase A — Migrations 000047 / 000048

- [ ] **A1. `entities` (000047)**:
```sql
CREATE TABLE IF NOT EXISTS entities (
    id              BIGSERIAL PRIMARY KEY,
    type            TEXT NOT NULL,              -- 'person' | 'company'
    canonical_name  TEXT NOT NULL,              -- display name
    normalized_name TEXT NOT NULL,              -- lower(trim(strip-suffixes)) for dedup
    stock_code      TEXT,                       -- for type='company', 1:1 with company-metadata
    attrs           JSONB NOT NULL DEFAULT '{}',-- {role, bio, image_url, linkedin_url} for persons
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (type, normalized_name)
);
CREATE INDEX IF NOT EXISTS idx_entities_stock_code ON entities(stock_code) WHERE stock_code IS NOT NULL;
```
- [ ] **A2. `entity_edges` (000048)**:
```sql
CREATE TABLE IF NOT EXISTS entity_edges (
    id            BIGSERIAL PRIMARY KEY,
    src_id        BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    dst_id        BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    edge_type     TEXT NOT NULL,                -- 'officer_of' | 'directs' | 'similar_to'
    weight        DOUBLE PRECISION NOT NULL DEFAULT 1.0,  -- e.g. cosine similarity for similar_to
    attrs         JSONB NOT NULL DEFAULT '{}',  -- {role} or {net_buy_value, trade_count} or {}
    source        TEXT,                          -- 'key_people' | 'director_trades' | 'narrative_sim'
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (src_id, dst_id, edge_type)
);
CREATE INDEX IF NOT EXISTS idx_entity_edges_src ON entity_edges(src_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_entity_edges_dst ON entity_edges(dst_id, edge_type);
```
- [ ] **A3.** Apply locally (or directly to prod via psql `statement_timeout=0` if local Docker is flaky — additive, safe). Commit. Apply to prod.

## Phase B — Company entities + company_summary embeddings (a Go backfill in the shorts service OR a small command)

- [ ] **B1.** Backfill **company** entities: one row per stock in company-metadata (`type='company'`, `stock_code=code`, `canonical_name=company_name`, `normalized_name`). Idempotent upsert. (A simple SQL `INSERT ... SELECT ... ON CONFLICT DO NOTHING` migration-style or a one-off Go/SQL run.)
- [ ] **B2.** Extend the **news-aggregator** embedder with a `RUN_MODE=embed-company-summaries`: for each company-metadata row with non-empty `enhanced_summary`, embed `enhanced_summary || '\n\n' || COALESCE(company_history,'')` → `embeddings(object_type='company_summary', object_id=stock_code)`. Reuse `EmbedBatch` (concurrent) + the `$N::vector` write. Idempotent (skip stocks already embedded).
- [ ] **B3.** Compute **`similar_to` edges**: for each company with a company_summary embedding, HNSW top-K (e.g. 6) nearest *other* company_summary embeddings (LITERAL vector — fetch the anchor's embedding, pass as `$1::vector`; never CROSS JOIN), insert `entity_edges(company→company, 'similar_to', weight=1-distance, source='narrative_sim')`. Exclude self; optionally exclude same-industry to surface cross-industry surprises (decide: keep all, it's fine).

## Phase C — Person entities + edges backfill

- [ ] **C1.** A backfill (Go command or SQL-driven): for each company-metadata row, parse `key_people` JSONB → for each person, upsert a `person` entity (dedupe on `normalized_name` = lower/trim/strip-titles), set attrs `{role,bio,image_url,linkedin_url}` (last-seen wins), and insert `entity_edges(person→company, 'officer_of', attrs={role}, source='key_people')`.
- [ ] **C2.** From `director_trades`: group by `(stock_code, director_name)`; upsert `person` entity (same dedup), insert `entity_edges(person→company, 'directs', attrs={trade_count, net_buy_value}, source='director_trades')`.
- [ ] **C3.** Normalization helper: `normalizePersonName` = lowercase, trim, strip honorifics/titles (Mr/Ms/Dr/Hon) and common suffixes; collapse whitespace. (Conservative — accept some split/merge; do NOT over-merge.)

> B/C can be one Go binary `cmd/graph-backfill` in the shorts service (reads company-metadata, key_people, director_trades; writes entities+edges), invoked locally against prod. Keep idempotent.

## Phase D — GetStockGraph RPC (4-layer)

- [ ] **D1. proto**: `rpc GetStockGraph(GetStockGraphRequest) returns (GetStockGraphResponse)` (PUBLIC). Request `{stock_code, limit}`. Response: `repeated GraphPerson people` (name, role, image_url, linkedin_url, `repeated string also_at` = OTHER stock_codes this person connects to), `repeated GraphPeer similar_companies` (stock_code, company_name, industry, similarity), `int32 person_count`.
- [ ] **D2. store** (`postgres_graph.go`): `GetStockGraph(stockCode, limit)`:
  - resolve the company entity id for stockCode;
  - **people**: persons with an edge to this company; for each, their OTHER company edges (`also_at`) via a join — `SELECT p.canonical_name, e.attrs->>'role', p.attrs->>'image_url', p.attrs->>'linkedin_url', array_agg(other.stock_code) FILTER (WHERE other.stock_code <> $1) ...`;
  - **similar_companies**: `similar_to` edges from this company → join entities for stock_code/name + company-metadata for industry, ordered by weight DESC LIMIT.
  - 4 layers (Store, ShortsStore, StoreAdapter, mock) + handler + cache key. Follow the GetRelatedNews pattern exactly.
- [ ] **D3.** `buf generate`; `go build ./shorts/...`; handler unit test via mock; integration test (testcontainer: seed entities+edges, assert people with `also_at` + similar companies).

## Phase E — Frontend "Connections" view

- [ ] **E1.** `web/src/@/components/company/stock-connections.tsx` — renders: **Leadership** (people cards with role + a "also at: X, Y" line linking to those stock pages — the new cross-company value) and **Similar companies** (narrative peers, linking to their pages, with a similarity hint). Server component fed by a `getStockGraph` server action, OR a client component like `related-news-rail.tsx`. Return null when empty.
- [ ] **E2.** Mount in the Overview tab (after `EnrichedCompanySection`) on `/shorts/[code]`. `tsc --noEmit` clean.

## Phase F — Backfill + deploy + verify
- [ ] **F1.** Apply migrations to prod (additive). Run `embed-company-summaries` (company embeddings) + the graph-backfill (entities/edges) + the similar_to computation against prod (bounded; reuse concurrency). ~hundreds of companies with enhanced_summary.
- [ ] **F2.** Merge → deploy (remember propagation lag). Verify live: `GetStockGraph` for a stock with multiple-board directors (e.g. a big bank) returns people with `also_at` + similar companies; load the page → Connections card renders.

## Risks / lessons applied
- **HNSW literal-vector** (Plan 1): the `similar_to` and any company-embedding ANN MUST pass the anchor embedding as a `$N::vector` literal — never a CROSS JOIN — or it full-scans and times out at scale. Add the EXPLAIN guard test.
- **Person dedup** is approximate (normalized name) — accept minor errors; never hard-merge across very different names.
- **Coverage**: only ~100-200 stocks have key_people/enhanced_summary → the graph is rich only where enrichment ran; the card returns null elsewhere (fine).
- Local Docker is flaky this session — validate migrations/queries against prod via psql.

## Success criteria
- `entities`/`entity_edges` populated; a director on multiple boards shows `also_at` other stocks; narrative-similar companies surface beyond industry peers; Connections card live on the stock page.
