import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("./000073_stock_price_coverage_and_news_image_index.up.sql", import.meta.url),
  "utf8",
);

test("stock price coverage migration materializes per-symbol price coverage", () => {
  assert.match(migration, /CREATE MATERIALIZED VIEW IF NOT EXISTS mv_stock_price_coverage/i);
  assert.match(migration, /GROUP BY stock_code/i);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_stock_price_coverage_stock_code/i);
  assert.match(migration, /latest_date/i);
});

test("stock price coverage migration exposes a targeted concurrent refresh function", () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION refresh_stock_price_coverage\(\)/i);
  assert.match(migration, /REFRESH MATERIALIZED VIEW CONCURRENTLY mv_stock_price_coverage/i);
});

test("news image migration adds a covering partial index for missing image backfills", () => {
  assert.match(migration, /idx_news_articles_missing_image_covering/i);
  assert.match(migration, /INCLUDE \(id, url, source\)/i);
  assert.match(migration, /WHERE image_url IS NULL/i);
});
