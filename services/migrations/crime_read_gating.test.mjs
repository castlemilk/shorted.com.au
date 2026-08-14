import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const up = readFileSync(
  new URL("./000092_crime_read_gating.up.sql", import.meta.url),
  "utf8",
);
const down = readFileSync(
  new URL("./000092_crime_read_gating.down.sql", import.meta.url),
  "utf8",
);

test("crime read snapshot keeps only latest reliable pooled commercial rows", () => {
  assert.match(up, /DROP MATERIALIZED VIEW IF EXISTS mv_suburb_crime_latest/i);
  assert.match(up, /SELECT DISTINCT ON \(sal_code, crime_type\)/i);
  assert.match(
    up,
    /rate_per_100k,\s*pct_rank,\s*population,\s*small_pop,\s*unreliable/i,
  );
  assert.match(up, /WHERE pooled AND pct_rank IS NOT NULL/i);
  assert.match(up, /AND NOT small_pop AND NOT unreliable/i);
  assert.match(up, /AND source_licence <> 'wa-tou-noncommercial'/i);
  assert.match(up, /ORDER BY sal_code, crime_type, fy_ending DESC/i);
});

test("crime read snapshot remains concurrency-refreshable with a guarded fallback", () => {
  assert.match(
    up,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_suburb_crime_latest[\s\S]*\(sal_code, crime_type\)/i,
  );
  assert.match(
    up,
    /REFRESH MATERIALIZED VIEW CONCURRENTLY mv_suburb_crime_latest/i,
  );
  assert.match(
    up,
    /EXCEPTION WHEN OTHERS THEN\s*REFRESH MATERIALIZED VIEW mv_suburb_crime_latest/i,
  );
});

test("down migration restores the pre-gating crime snapshot and refresh wiring", () => {
  assert.match(
    down,
    /SELECT DISTINCT ON \(sal_code, crime_type\)[\s\S]*small_pop,\s*source_jurisdiction,\s*source_licence/i,
  );
  assert.doesNotMatch(down, /AND NOT small_pop AND NOT unreliable/i);
  assert.match(
    down,
    /REFRESH MATERIALIZED VIEW CONCURRENTLY mv_suburb_crime_latest/i,
  );
});
