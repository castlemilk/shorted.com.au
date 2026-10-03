# Batch quote query: synthetic PostgreSQL comparison

Measured on 2026-10-03 with Go 1.26.7 on macOS ARM64 and an isolated Docker
PostgreSQL 16 container (`postgres:16-alpine`, image digest
`postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea`).
The integration harness defaults to PostgreSQL 15; the local run explicitly
selected the available PostgreSQL 16 image.

The fixture contains **1,000,000 rows: 200 symbols with 5,000 dated prices each**.
It copies the existing stock-price schema and indexes, including unique
`(stock_code, date)` and `(stock_code, date DESC)`. No index or migration was added.

The former query used two historical `DISTINCT ON` selections. The replacement
deduplicates requested symbols and performs two lateral ordered `LIMIT 1`
lookups: latest price, then the closest strictly earlier date. Both queries
return identical SQL rows, checked with `EXCEPT ALL` in both directions for
duplicates, missing coverage, nullable adjusted/previous closes, and each
benchmark batch. Separate service tests cover trading-date gaps, one stored
observation, zero previous close, normalized inputs, malformed required fields,
and cancellation. Malformed or interrupted row decoding now returns an error
instead of empty or partial success.

| Symbols | Former DB execution | Indexed DB execution | Former price rows examined | Indexed price rows examined | Former shared blocks | Indexed shared blocks |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 4.516 ms | 0.1030 ms | 10,001 | 2 | 127 | 8 |
| 20 | 101.6 ms | 0.4643 ms | 200,001 | 40 | 2,477 | 160 |
| 50 | 232.9 ms | 1.015 ms | 500,001 | 100 | 6,185 | 400 |

These are means of three `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` executions
after fixture creation, analysis, and equivalence checks warmed the database.
DB execution time excludes client/network/connection startup. Price rows examined
sum actual rows and rows removed by filters/rechecks on `stock_prices` plan nodes,
multiplied by their loop counts. Shared blocks are root-plan hits plus reads.
The six JSON files capture the first plan from each three-execution sample.

This proves the query avoids scanning each requested symbol's history in this
fixture. It does **not** establish production latency or billed savings, or explain
the separately observed 33–45-second upstream responses. Production rollout
must still check the live index, query plans, pool/network delays, and errors.

To reproduce, use Docker and the repository's existing Go workspace/private
module setup, then run from `services/`:

```sh
GOTOOLCHAIN=go1.26.7 \
MARKET_DATA_TEST_POSTGRES_IMAGE=postgres:16-alpine \
go test ./market-data -tags=integration \
  -run 'Test(GetMultipleStockPrices|ReadMultipleStockPrices)' \
  -bench '^BenchmarkMultipleStockPricesQuery$' -benchtime=3x \
  -count=1 -timeout=10m -v
```

Temporary checkouts may need a temporary `GOWORK` file pointing the existing
`github.com/skunkworq/stealth` replacement to its actual checkout. The recorded
local run also set `TESTCONTAINERS_RYUK_DISABLED=true`; the harness explicitly
stopped and removed its own PostgreSQL container. No production database or
credentials were used, and the shared Go cache was not cleaned.
